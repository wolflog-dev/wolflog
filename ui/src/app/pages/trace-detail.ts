import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, SpanItem, TraceDetail } from '../core/api';
import { DurPipe, TimePipe, parseJson } from '../core/format';
import { paletteColor } from '../shared/chart';
import { Attributes, CopyText, LevelBadge } from '../shared/widgets';
import { HttpExchange } from '../shared/http-exchange';

interface Row {
  span: SpanItem;
  depth: number;
  offsetMs: number;
  color: string;
}

const KINDS = ['', 'interne', 'serveur', 'client', 'producteur', 'consommateur'];

@Component({
  selector: 'vg-trace-detail',
  imports: [RouterLink, DurPipe, TimePipe, Attributes, CopyText, LevelBadge, HttpExchange],
  host: { '(document:keydown.escape)': 'selected.set(null)' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <a routerLink="/traces" class="small">Traces</a>
        <span class="muted">/</span>
        <h1 class="mono ellipsis">{{ rows()[0]?.span?.name ?? 'Trace' }}</h1>
        <span class="spacer"></span>
        <span class="mono small muted">{{ id() }}</span> <vg-copy [text]="id()" />
      </div>

      @if (detail(); as d) {
        @if (!d.spans.length) {
          <div class="panel empty">Trace introuvable : expirée, ou pas encore reçue.</div>
        } @else {
          <div class="panel facts">
            <div><span>Durée</span><strong>{{ totalMs() | dur }}</strong></div>
            <div><span>Spans</span><strong>{{ d.spans.length }}</strong></div>
            <div><span>Erreurs</span><strong [class.danger]="errorCount() > 0">{{ errorCount() }}</strong></div>
            <div><span>Début</span><strong class="mono">{{ d.spans[0].ts | time: true }}</strong></div>
            <div class="legend">
              @for (s of services(); track s.name) {
                <span><i [style.background]="s.color"></i>{{ s.name }}</span>
              }
            </div>
          </div>

          <div class="split" [class.with-detail]="selected()">
            <section class="panel waterfall">
              <div class="wf-head small muted">
                <span>Opération</span>
                <div class="ticks">
                  @for (t of ticks(); track $index) { <span [style.left.%]="t.pct">{{ t.label }}</span> }
                </div>
                <span class="r">Durée</span>
              </div>
              @for (r of rows(); track r.span.spanId) {
                <div class="wf-row" [class.sel]="selected() === r.span" (click)="selected.set(selected() === r.span ? null : r.span)">
                  <div class="wf-name" [style.padding-left.px]="12 + r.depth * 14">
                    <i [style.background]="r.color"></i>
                    <span class="mono ellipsis" [class.danger]="r.span.statusCode === 2">{{ r.span.name }}</span>
                  </div>
                  <div class="wf-track">
                    <div class="wf-bar" [class.err]="r.span.statusCode === 2"
                         [style.left.%]="(r.offsetMs / totalMs()) * 100"
                         [style.width.%]="max(0.3, (r.span.durationMs / totalMs()) * 100)"
                         [style.background]="r.span.statusCode === 2 ? null : r.color"></div>
                  </div>
                  <span class="wf-dur mono">{{ r.span.durationMs | dur }}</span>
                </div>
              }
            </section>

            @if (selected(); as s) {
              <aside class="panel detail">
                <div class="panel-head">
                  <strong class="mono ellipsis">{{ s.name }}</strong>
                  <span class="spacer"></span>
                  <button class="btn ghost" (click)="selected.set(null)">Fermer</button>
                </div>
                <div class="detail-body">
                  <table class="ctx">
                    <tr><td>Service</td><td>{{ s.service }}</td></tr>
                    <tr><td>Type</td><td>{{ kind(s.kind) }}</td></tr>
                    <tr><td>Durée</td><td>{{ s.durationMs | dur }}</td></tr>
                    <tr><td>Début</td><td class="mono">{{ s.ts | time: true }}</td></tr>
                    <tr><td>Statut</td><td [class.danger]="s.statusCode === 2">{{ s.statusCode === 2 ? 'erreur' : s.statusCode === 1 ? 'ok' : 'non défini' }} {{ s.statusMessage ?? '' }}</td></tr>
                    <tr><td>Span</td><td class="mono">{{ s.spanId }} <vg-copy [text]="s.spanId" /></td></tr>
                    <tr><td>Source</td><td class="mono">{{ s.scope ?? '–' }}</td></tr>
                  </table>
                  @if (isHttp(s)) {
                    <h3>Échange HTTP</h3>
                    <vg-http-exchange [attributes]="s.attributes" />
                  }
                  <h3>Attributs</h3>
                  <vg-attributes [json]="s.attributes" [hideHttp]="true" />
                  @if (events(s).length) {
                    <h3>Événements</h3>
                    @for (e of events(s); track $index) {
                      <div class="event">
                        <div><span class="mono">{{ e.name }}</span> <span class="muted small mono">{{ e.ts | time }}</span></div>
                        @if (e.name === 'exception') {
                          <pre class="stack">{{ e.attributes['exception.stacktrace'] ?? e.attributes['exception.message'] }}</pre>
                        } @else {
                          <vg-attributes [json]="stringify(e.attributes)" />
                        }
                      </div>
                    }
                  }
                  <h3>Logs du span</h3>
                  @for (l of spanLogs(s); track $index) {
                    <div class="log"><vg-level [level]="l.level" /> <span class="mono">{{ l.body }}</span></div>
                  } @empty {
                    <div class="muted small">Aucun log émis dans ce span.</div>
                  }
                </div>
              </aside>
            }
          </div>

          <section class="panel">
            <div class="panel-head"><h2>Logs de la trace</h2><span class="muted small">{{ d.logs.length }}</span></div>
            @for (l of d.logs; track $index) {
              <div class="logrow">
                <span class="mono small muted">{{ l.ts | time }}</span>
                <vg-level [level]="l.level" />
                <span class="small ellipsis">{{ l.service }}</span>
                <span class="mono ellipsis">{{ l.body }}</span>
              </div>
            } @empty {
              <div class="empty">Aucun log rattaché à cette trace.</div>
            }
          </section>
        }
      }
    </div>
  `,
  styles: `
    h1 { max-width: 55vw; }
    .facts { display: flex; flex-wrap: wrap; align-items: stretch; }
    .facts > div { display: grid; gap: 2px; padding: 8px 16px; border-right: 1px solid var(--border); }
    .facts span { font-size: 11.5px; color: var(--text-3); }
    .facts strong { font-weight: 600; }
    .facts .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; align-content: center; border-right: 0; margin-left: auto; font-size: 12px; color: var(--text-2); }
    .legend i, .wf-name i { display: inline-block; width: 8px; height: 8px; margin-right: 6px; flex: none; }
    .split { display: grid; gap: 14px; }
    .split.with-detail { grid-template-columns: minmax(0, 1fr) minmax(420px, 44%); }
    .waterfall { overflow: hidden; }
    .wf-head, .wf-row { display: grid; grid-template-columns: minmax(220px, 34%) 1fr 80px; }
    .wf-head { border-bottom: 1px solid var(--border); padding: 7px 0; font-size: 11px; }
    .wf-head > span { padding-left: 12px; }
    .ticks { position: relative; }
    .wf-head .r { text-align: right; padding-right: 12px; }
    .ticks span { position: absolute; white-space: nowrap; }
    .wf-row { height: 24px; align-items: center; cursor: default; border-bottom: 1px solid var(--border-soft); }
    .wf-row:hover { background: var(--row-hover); }
    .wf-row.sel { background: var(--row-selected); }
    .wf-name { display: flex; align-items: center; min-width: 0; font-size: 12px; padding-right: 8px; }
    .wf-track { position: relative; height: 100%; margin-right: 8px; border-left: 1px solid var(--border-soft); }
    .wf-bar { position: absolute; top: 7px; height: 10px; min-width: 2px; opacity: .85; }
    .wf-bar.err { background: var(--danger); }
    .wf-dur { text-align: right; padding-right: 12px; font-size: 11.5px; color: var(--text-2); white-space: nowrap; }
    .detail { display: flex; flex-direction: column; max-height: calc(100vh - 120px); position: sticky; top: 60px; overflow: hidden; }
    .detail-body { overflow: auto; padding: 12px; min-height: 0; }
    .detail-body > * + * { margin-top: 8px; }
    .ctx { font-size: 12px; border-collapse: collapse; width: 100%; table-layout: fixed; }
    .ctx td { overflow-wrap: anywhere; }
    .ctx td:first-child { width: 110px; }
    .ctx td { padding: 2px 16px 2px 0; vertical-align: top; }
    .ctx td:first-child { color: var(--text-3); white-space: nowrap; }
    h3 { margin-top: 6px; }
    .event { display: grid; gap: 4px; font-size: 12px; }
    .log { font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
    .logrow { display: grid; grid-template-columns: 100px 30px 120px minmax(0, 1fr); gap: 12px; align-items: center; padding: 4px 12px;
      border-bottom: 1px solid var(--border-soft); font-size: 12.5px; }
    @media (max-width: 1200px) {
      .split.with-detail { grid-template-columns: 1fr; }
      .detail { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100%); max-height: none; z-index: 60; border-radius: 0; box-shadow: -12px 0 32px rgba(0, 0, 0, .35); }
    }
  `,
})
export class TraceDetailPage {
  private readonly api = inject(Api);
  readonly id = input.required<string>();
  readonly around = input<string | null>(null);
  /** Span à ouvrir directement (lien depuis la page Requêtes HTTP). */
  readonly span = input<string | null>(null);
  protected readonly detail = signal<TraceDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly selected = signal<SpanItem | null>(null);
  protected readonly max = Math.max;
  protected readonly min = Math.min;

  protected readonly services = computed(() => {
    const names = [...new Set((this.detail()?.spans ?? []).map((s) => s.service))];
    return names.map((name, i) => ({ name, color: paletteColor(i) }));
  });

  private readonly start = computed(() => Math.min(...(this.detail()?.spans ?? []).map((s) => new Date(s.ts).getTime())));

  protected readonly totalMs = computed(() => {
    const spans = this.detail()?.spans ?? [];
    if (!spans.length) return 1;
    const end = Math.max(...spans.map((s) => new Date(s.ts).getTime() + s.durationMs));
    return Math.max(end - this.start(), 0.001);
  });

  protected readonly errorCount = computed(() => (this.detail()?.spans ?? []).filter((s) => s.statusCode === 2).length);

  /** Ordre de l'arbre : parent puis enfants par date de début. */
  protected readonly rows = computed<Row[]>(() => {
    const spans = this.detail()?.spans ?? [];
    const colors = new Map(this.services().map((s) => [s.name, s.color]));
    const ids = new Set(spans.map((s) => s.spanId));
    const children = new Map<string, SpanItem[]>();
    const roots: SpanItem[] = [];
    for (const s of spans) {
      if (s.parentSpanId && ids.has(s.parentSpanId)) {
        const list = children.get(s.parentSpanId) ?? [];
        list.push(s);
        children.set(s.parentSpanId, list);
      } else {
        roots.push(s);
      }
    }
    const byStart = (a: SpanItem, b: SpanItem) => new Date(a.ts).getTime() - new Date(b.ts).getTime();
    const out: Row[] = [];
    const start = this.start();
    const visit = (s: SpanItem, depth: number) => {
      out.push({ span: s, depth, offsetMs: new Date(s.ts).getTime() - start, color: colors.get(s.service) ?? '#888' });
      for (const c of (children.get(s.spanId) ?? []).sort(byStart)) visit(c, depth + 1);
    };
    for (const r of roots.sort(byStart)) visit(r, 0);
    return out;
  });

  protected readonly ticks = computed(() => {
    const total = this.totalMs();
    return [0, 0.25, 0.5, 0.75].map((f) => ({ pct: f * 100, label: f === 0 ? '0' : formatTick(total * f) }));
  });

  constructor() {
    effect(() => {
      const id = this.id();
      const around = this.around();
      untracked(() => {
        this.loading.set(true);
        this.api.trace(id, around).subscribe({
          next: (d) => {
            this.detail.set(d);
            this.loading.set(false);
            // Span demandé, sinon le premier en erreur, sinon la racine : le détail est visible sans clic.
            const wanted = this.span();
            const byId = wanted ? d.spans.find((x) => x.spanId === wanted) : undefined;
            const failed = d.spans.find((x) => x.statusCode === 2 && x.kind === 2) ?? d.spans.find((x) => x.statusCode === 2);
            const root = d.spans.find((x) => !x.parentSpanId || !d.spans.some((p) => p.spanId === x.parentSpanId));
            this.selected.set(byId ?? failed ?? root ?? null);
          },
          error: () => this.loading.set(false),
        });
      });
    });
  }

  kind(k: number) { return KINDS[k] ?? '–'; }

  isHttp(s: SpanItem) { return s.attributes.includes('"http.request.method"'); }

  events(s: SpanItem): { name: string; ts: string; attributes: Record<string, string> }[] {
    try { return JSON.parse(s.events); } catch { return []; }
  }

  stringify(v: unknown) { return JSON.stringify(v); }

  spanLogs(s: SpanItem) {
    return (this.detail()?.logs ?? []).filter((l) => l.spanId === s.spanId);
  }

  protected readonly parseJson = parseJson;
}

function formatTick(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
