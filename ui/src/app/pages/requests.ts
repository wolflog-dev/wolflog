import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api, HttpQuery, HttpRequestItem, HttpSummary, LogItem, MetricData, Panel, SpanItem } from '../core/api';
import { AppState, Session } from '../core/state';
import { DurPipe, NumPipe, TimePipe } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';
import { AddToDashboard } from '../shared/add-to-dashboard';
import { HttpExchange } from '../shared/http-exchange';
import { CopyText, LevelBadge } from '../shared/widgets';
import { SavedSearches } from '../shared/saved-searches';

const STATUS_COLORS: Record<string, string> = { '2': '#5a6780', '3': '#7aa2f7', '4': '#c9973f', '5': '#d45f5f' };

@Component({
  selector: 'vg-requests',
  imports: [FormsModule, RouterLink, Chart, DurPipe, NumPipe, TimePipe, AddToDashboard, HttpExchange, LevelBadge, CopyText, SavedSearches],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Requêtes HTTP</h1>
        <div class="seg">
          <button [class.on]="direction() === 'in'" (click)="direction.set('in')">Reçues</button>
          <button [class.on]="direction() === 'out'" (click)="direction.set('out')">Sortantes</button>
        </div>
        <div class="seg">
          @for (s of statuses; track s.value) {
            <button [class.on]="status() === s.value" (click)="status.set(s.value)">{{ s.label }}</button>
          }
        </div>
        <input [ngModel]="text()" (ngModelChange)="typed($event)" [placeholder]="direction() === 'in' ? 'Route ou chemin, ex. /api/orders' : 'Hôte ou URL'" class="q" aria-label="Filtrer" />
        <input [ngModel]="minMs()" (ngModelChange)="minMs.set($event || null)" type="number" min="0" placeholder="Plus lentes que (ms)" class="min" aria-label="Durée minimale" />
        <span class="spacer"></span>
        <vg-saved-searches page="requests" [params]="searchParams()" (apply)="applySaved($event)" />
        <vg-add-to-dashboard [panel]="panelForView()" />
      </div>

      @if (summary(); as s) {
        <div class="panel facts">
          <div><span>Requêtes</span><strong>{{ s.count | num }}</strong></div>
          <div><span>Débit</span><strong>{{ s.ratePerSecond | num }} /s</strong></div>
          <div class="click" (click)="status.set('errors')" title="Afficher les requêtes en erreur">
            <span>Erreurs (5xx)</span><strong [class.danger]="s.errors > 0">{{ s.errors | num }}</strong><em>{{ s.errorRate | num }} %</em>
          </div>
          <div><span>Médiane</span><strong>{{ s.p50Ms | dur }}</strong></div>
          <div><span>p95</span><strong>{{ s.p95Ms | dur }}</strong></div>
          <div><span>p99</span><strong>{{ s.p99Ms | dur }}</strong></div>
          @if (s.count) {
            <div class="export"><span>Exporter la liste</span>
              <strong><a [href]="exportUrl('csv')" download title="Jusqu'à 10 000 requêtes, séparateur point-virgule (Excel)">CSV</a>
                <a [href]="exportUrl('json')" download title="Jusqu'à 10 000 requêtes">JSON</a></strong>
            </div>
            @if (session.canEdit() && direction() === 'in') {
              <div class="alert-link"><span>Être prévenu</span>
                <strong><a routerLink="/alerts" [queryParams]="alertParams()" title="Alerte sur le taux d'erreur de ces requêtes">Créer une alerte</a></strong>
              </div>
            }
          }
        </div>
      }

      @if (series(); as d) {
        <div class="panel chart-panel">
          <vg-chart [times]="d.times" [series]="chartSeries()" kind="bars" [stacked]="true" [height]="96" unit="req/s" (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
        </div>
      }

      <div class="split" [class.with-detail]="selected()">
        <section class="panel list-panel">
          @if (items().length) {
            <table class="list">
              <thead>
                <tr><th>Date</th><th>Méthode</th><th>{{ direction() === 'in' ? 'Route' : 'Hôte' }}</th><th class="hide-detail">Chemin</th><th class="hide-detail">Service</th><th class="r">Statut</th><th class="r">Durée</th></tr>
              </thead>
              <tbody>
                @for (r of items(); track r.spanId) {
                  <tr class="click" [class.sel]="r === selected()" (click)="select(r)">
                    <td class="mono small muted nowrap">{{ r.ts | time: true }}</td>
                    <td class="mono">{{ r.method }}</td>
                    <td class="mono ellipsis route" [title]="r.target">{{ r.route ?? r.target }}</td>
                    <td class="mono ellipsis target muted hide-detail">{{ r.target }}</td>
                    <td class="nowrap hide-detail">{{ r.service }}</td>
                    <td class="r mono" [class.danger]="r.error" [class.warn]="!r.error && (r.status ?? 0) >= 400">{{ r.status ?? '–' }}</td>
                    <td class="r mono nowrap">{{ r.durationMs | dur }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else if (!loading()) {
            <div class="empty">
              Aucune requête sur cette période.
              @if (text() || status() || minMs()) { <a (click)="resetFilters()">Effacer les filtres</a> }
            </div>
          }
        </section>

        @if (selected(); as r) {
          <aside class="panel detail">
            <div class="panel-head">
              <strong class="mono ellipsis">{{ r.method }} {{ r.route ?? r.target }}</strong>
              <span class="spacer"></span>
              <span class="muted small hide-narrow"><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Échap</kbd></span>
              <button class="btn ghost" (click)="selected.set(null)">Fermer</button>
            </div>
            <div class="detail-body">
              <div class="meta small">
                <span>{{ r.ts | time: true }}</span>
                <span>{{ r.service }}</span>
                <span [class.danger]="r.error">{{ r.status ?? '–' }}</span>
                <span>{{ r.durationMs | dur }}</span>
                <span class="mono muted">trace {{ r.traceId.slice(0, 12) }}… <vg-copy [text]="r.traceId" /></span>
                <span class="spacer"></span>
                <a class="btn" [routerLink]="['/traces', r.traceId]" [queryParams]="{ around: r.ts, span: r.spanId }">Trace complète</a>
              </div>
              @if (span(); as s) {
                <vg-http-exchange [attributes]="s.attributes" />
                <h3>Logs de la requête ({{ spanLogs().length }})</h3>
                @for (l of spanLogs(); track $index) {
                  <div class="log small"><span class="mono muted">{{ l.ts | time }}</span><vg-level [level]="l.level" /><span class="mono">{{ l.body }}</span></div>
                } @empty {
                  <p class="muted small">Aucun log émis pendant cette requête.</p>
                }
              } @else {
                <p class="muted small">Chargement…</p>
              }
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .q { width: 220px; }
    .min { width: 150px; }
    .facts { display: flex; flex-wrap: wrap; }
    .facts > div { display: grid; gap: 2px; padding: 8px 16px; border-right: 1px solid var(--border); min-width: 110px; }
    .facts > div:last-child { border-right: 0; }
    .facts > div.click { cursor: pointer; }
    .facts > div.click:hover { background: var(--row-hover); }
    .facts span, .facts em { font-size: 11.5px; color: var(--text-3); font-style: normal; }
    .facts strong { font-weight: 600; font-size: 15px; }
    .chart-panel { padding: 4px 10px 0; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-detail { grid-template-columns: minmax(0, 1fr) minmax(460px, 48%); }
    .with-detail .hide-detail { display: none; }
    .route { max-width: 0; width: 34%; }
    .target { max-width: 0; width: 28%; }
    tr.sel td { background: var(--row-selected); }
    tr.sel td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
    .warn { color: var(--warn); }
    .empty a { cursor: pointer; margin-left: 6px; }
    .detail { position: sticky; top: 62px; max-height: calc(100vh - 80px); display: flex; flex-direction: column; overflow: hidden; }
    .detail .panel-head { flex: none; }
    .detail-body { overflow: auto; padding: 12px; }
    .detail-body > * + * { margin-top: 10px; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
    .meta .btn { height: 26px; }
    h3 { margin-top: 16px; }
    .log { display: grid; grid-template-columns: 90px 30px minmax(0, 1fr); gap: 10px; padding: 3px 0; border-bottom: 1px solid var(--border-soft); }
    .log .mono:last-child { overflow-wrap: anywhere; }
    p { margin: 0; }
    .facts .alert-link { border-right: 0; border-left: 1px solid var(--border); }
    .alert-link a { font-weight: 500; }
    .facts .export { margin-left: auto; border-right: 0; border-left: 1px solid var(--border); }
    .export a { font-weight: 500; margin-right: 8px; }
    @media (max-width: 1200px) {
      .split.with-detail { grid-template-columns: minmax(0, 1fr); }
      .detail { position: fixed; top: 0; right: 0; bottom: 0; max-height: none; width: min(640px, 100%); z-index: 60; border-radius: 0; box-shadow: -12px 0 32px rgba(0, 0, 0, .35); }
      .hide-narrow { display: none; }
    }
  `,
})
export class RequestsPage implements OnDestroy {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);

  /** Paramètre d'URL (recherche globale). */
  readonly q = input<string>('');
  readonly statusParam = input<string>('', { alias: 'status' });
  readonly directionParam = input<string>('', { alias: 'direction' });
  readonly minMsParam = input<string>('', { alias: 'minMs' });

  protected readonly statuses = [
    { value: '', label: 'Toutes' },
    { value: '2xx', label: '2xx' },
    { value: '4xx', label: '4xx' },
    { value: '5xx', label: '5xx' },
    { value: 'errors', label: 'En erreur' },
  ];
  protected readonly direction = signal<'in' | 'out'>('in');
  protected readonly status = signal('');
  protected readonly text = signal('');
  protected readonly minMs = signal<number | null>(null);
  private readonly appliedText = signal('');
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly items = signal<HttpRequestItem[]>([]);
  protected readonly summary = signal<HttpSummary | null>(null);
  protected readonly series = signal<MetricData | null>(null);
  protected readonly loading = signal(false);
  protected readonly selected = signal<HttpRequestItem | null>(null);
  protected readonly span = signal<SpanItem | null>(null);
  protected readonly spanLogs = signal<LogItem[]>([]);
  private subs: Subscription[] = [];
  private detailSub?: Subscription;

  protected readonly panelForView = computed<Panel>(() => {
    const out = this.direction() === 'out';
    const scope = [this.appliedText(), this.status()].filter(Boolean).join(', ');
    return {
      id: '', type: 'http', width: 6, height: 'm', stat: 'rate', groupBy: 'status', outgoing: out,
      title: `${out ? 'Appels sortants' : 'Requêtes'} par code HTTP${scope ? ' (' + scope + ')' : ''}`,
      query: this.appliedText() || null, statusClass: this.status() || null, service: this.state.service() || null,
    };
  });

  protected readonly chartSeries = computed<ChartSeries[]>(() => {
    // Regroupement par classe de statut (2xx, 4xx, 5xx) pour un graphique lisible.
    const d = this.series();
    if (!d) return [];
    const classes = new Map<string, (number | null)[]>();
    for (const s of d.series) {
      const cls = /^\d/.test(s.group) ? s.group[0] : '–';
      const acc = classes.get(cls) ?? d.times.map(() => 0);
      s.values.forEach((v, i) => (acc[i] = (acc[i] ?? 0) + (v ?? 0)));
      classes.set(cls, acc);
    }
    return [...classes.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cls, values]) => ({ label: cls === '–' ? 'sans statut' : `${cls}xx`, color: STATUS_COLORS[cls] ?? '#6f747e', values }));
  });

  constructor() {
    effect(() => {
      const q = this.q();
      const status = this.statusParam();
      const direction = this.directionParam();
      const minMs = this.minMsParam();
      untracked(() => {
        this.text.set(q ?? '');
        this.appliedText.set((q ?? '').trim());
        if (status) this.status.set(status);
        if (direction === 'out' || direction === 'in') this.direction.set(direction);
        if (minMs) this.minMs.set(Number(minMs) || null);
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      this.direction();
      this.status();
      this.appliedText();
      this.minMs();
      untracked(() => this.load());
    });
  }

  protected readonly searchParams = computed(() => ({
    q: this.appliedText(), status: this.status(), minMs: this.minMs() ? String(this.minMs()) : '', direction: this.direction() === 'out' ? 'out' : '',
  }));

  protected applySaved(p: Record<string, string>) {
    this.text.set(p['q'] ?? '');
    this.appliedText.set((p['q'] ?? '').trim());
    this.status.set(p['status'] ?? '');
    this.minMs.set(p['minMs'] ? Number(p['minMs']) : null);
    this.direction.set(p['direction'] === 'out' ? 'out' : 'in');
  }

  protected readonly session = inject(Session);

  protected alertParams() {
    const p: Record<string, string> = { edit: 'new', kind: 'http', stat: 'errorRate' };
    if (this.state.service()) p['service'] = this.state.service();
    if (this.appliedText()) p['route'] = this.appliedText();
    return p;
  }

  protected exportUrl(format: 'csv' | 'json') {
    return this.api.exportUrl('requests', format, {
      ...this.state.range(), service: this.state.service(), q: this.appliedText(), status: this.status(), minMs: this.minMs(),
      direction: this.direction(), env: this.state.env(),
    });
  }

  protected typed(value: string) {
    this.text.set(value);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.appliedText.set(value.trim()), 300);
  }

  protected resetFilters() {
    this.text.set('');
    this.appliedText.set('');
    this.status.set('');
    this.minMs.set(null);
  }

  private load() {
    this.subs.forEach((s) => s.unsubscribe());
    this.loading.set(true);
    const r = this.state.range();
    const f: HttpQuery = {
      service: this.state.service(),
      q: this.appliedText(),
      minMs: this.minMs(),
      status: this.status(),
      direction: this.direction(),
    };
    this.subs = [
      this.api.requests(r, f).subscribe({
        next: (items) => {
          const open = this.selected();
          this.items.set(items);
          if (open && !items.some((i) => i.spanId === open.spanId)) this.selected.set(null);
          else if (open) this.selected.set(items.find((i) => i.spanId === open.spanId)!);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      }),
      this.api.requestSummary(r, f).subscribe((s) => this.summary.set(s)),
      this.api.requestSeries(r, f, 'rate', 'status').subscribe((s) => this.series.set(s)),
    ];
  }

  /** Détail dans le panneau de droite, sans quitter la liste. */
  protected select(r: HttpRequestItem) {
    if (this.selected() === r) {
      this.selected.set(null);
      return;
    }
    this.selected.set(r);
    this.span.set(null);
    this.spanLogs.set([]);
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.trace(r.traceId, r.ts).subscribe((t) => {
      if (this.selected() !== r) return;
      this.span.set(t.spans.find((s) => s.spanId === r.spanId) ?? null);
      this.spanLogs.set(t.logs.filter((l) => l.spanId === r.spanId || (!l.spanId && t.spans.length === 1)));
    });
  }

  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') this.selected.set(null);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.items().length) {
      e.preventDefault();
      const list = this.items();
      const current = this.selected() ? list.indexOf(this.selected()!) : -1;
      const next = Math.max(0, Math.min(list.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
      if (list[next] !== this.selected()) this.select(list[next]);
      document.querySelectorAll('vg-requests tr.click')[next]?.scrollIntoView({ block: 'nearest' });
    }
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
    this.detailSub?.unsubscribe();
    if (this.typingTimer) clearTimeout(this.typingTimer);
  }
}
