import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { LogItem, SpanItem, TraceDetail } from '../core/models';
import { DurPipe } from '../core/pipes/dur-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { formatDuration, parseJson } from '../core/format';
import { paletteColor } from '../shared/chart';
import { Attributes } from '../shared/attributes';
import { CopyText } from '../shared/copy-text';
import { CountUp } from '../shared/count-up';
import { LevelBadge } from '../shared/level-badge';
import { HttpExchange } from '../shared/http-exchange';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';

interface Row {
  span: SpanItem;
  depth: number;
  offsetMs: number;
  color: string;
  /** Enfants directs (flèche de repli) ; descendants masqués quand le span est replié. */
  children: number;
  hidden: number;
}

interface SpanEvent {
  name: string;
  ts: string;
  attributes: Record<string, string>;
}

const KINDS = ['', 'interne', 'serveur', 'client', 'producteur', 'consommateur'];
const KIND_ICONS = ['layers', 'code', 'server', 'globe', 'arrow-up', 'arrow-down'];

@Component({
  selector: 'wl-trace-detail',
  imports: [RouterLink, DurPipe, NumPipe, TimePipe, Attributes, CopyText, CountUp, LevelBadge, HttpExchange, NavIcon, Skeleton],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <a routerLink="/traces" class="crumb small"><wl-nav-icon name="traces" [size]="13" />Traces</a>
        <wl-nav-icon name="chevron-right" [size]="12" class="sep" />
        <h1 class="mono ellipsis" [title]="rows()[0]?.span?.name ?? ''">{{ rows()[0]?.span?.name ?? 'Trace' }}</h1>
        @if (errorCount()) { <span class="tag err">{{ errorCount() }} erreur{{ errorCount() > 1 ? 's' : '' }}</span> }
        <span class="spacer"></span>
        <span class="trace-id"><wl-nav-icon name="hash" [size]="12" /><span class="mono small" [title]="id()">{{ id() }}</span><wl-copy [text]="id()" /></span>
        <a class="btn" routerLink="/logs" [queryParams]="{ q: 'trace:' + id() }" title="Rechercher tous les logs de cette trace"><wl-nav-icon name="logs" [size]="14" />Logs de la trace</a>
      </div>

      @if (detail(); as d) {
        @if (!d.spans.length) {
          <div class="panel empty">
            <p class="lead-text">Trace introuvable : expirée, ou pas encore reçue.</p>
            <p class="hint">Les spans arrivent parfois avec quelques secondes de retard : réessayez dans un instant.</p>
            <div class="cta">
              <button class="btn" (click)="fetch()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button>
              <a class="btn ghost" routerLink="/traces"><wl-nav-icon name="traces" [size]="14" />Retour aux traces</a>
            </div>
          </div>
        } @else {
          <div class="panel facts">
            <div><span>Durée</span><strong class="big" [wlCountUp]="totalMs() | dur"></strong></div>
            <div><span>Spans</span><strong class="big" [wlCountUp]="d.spans.length | num"></strong></div>
            <div><span>Erreurs</span><strong class="big" [class.danger]="errorCount() > 0" [wlCountUp]="errorCount() | num"></strong></div>
            <div [title]="fullDate(d.spans[0].ts)"><span>Début</span><strong class="mono">{{ d.spans[0].ts | time: true }}</strong></div>
            <div class="legend" aria-label="Services de la trace">
              @for (s of services(); track s.name) {
                <span class="svc" tabindex="0" [class.on]="focusService() === s.name" [title]="'Survoler pour repérer ses ' + s.count + ' span' + (s.count > 1 ? 's' : '')"
                      (mouseenter)="focusService.set(s.name)" (mouseleave)="focusService.set(null)" (focus)="focusService.set(s.name)" (blur)="focusService.set(null)">
                  <i [style.background]="s.color"></i>{{ s.name }}<span class="n">{{ s.count }}</span>
                </span>
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
              @for (r of rows(); track r.span.spanId; let i = $index) {
                <div class="wf-row" [class.sel]="selected() === r.span" [class.err]="r.span.statusCode === 2"
                     [class.dim]="!!focusService() && r.span.service !== focusService()" [style.--i]="i" (click)="toggleSpan(r.span)">
                  <div class="wf-name" [style.padding-left.px]="6 + r.depth * 14">
                    @if (r.children) {
                      <button type="button" class="twist" [class.closed]="r.hidden" (click)="setCollapsed(r.span, !r.hidden); $event.stopPropagation()"
                              [title]="r.hidden ? 'Déplier (' + r.hidden + ' span' + (r.hidden > 1 ? 's' : '') + ')' : 'Replier les spans enfants'"
                              [attr.aria-label]="r.hidden ? 'Déplier les spans enfants' : 'Replier les spans enfants'" [attr.aria-expanded]="!r.hidden">
                        <wl-nav-icon name="chevron" [size]="12" />
                      </button>
                    } @else {
                      <span class="twist-gap"></span>
                    }
                    <i class="svc-dot" [style.background]="r.color"></i>
                    <span class="mono ellipsis name" [title]="r.span.name + ' · ' + r.span.service">{{ r.span.name }}</span>
                    @if (r.hidden) { <span class="hidden-count">+{{ r.hidden }}</span> }
                  </div>
                  <div class="wf-track" [title]="barTip(r)">
                    <div class="wf-bar" [class.err]="r.span.statusCode === 2"
                         [style.left.%]="(r.offsetMs / totalMs()) * 100"
                         [style.width.%]="max(0.3, (r.span.durationMs / totalMs()) * 100)"
                         [style.background]="r.span.statusCode === 2 ? null : r.color"></div>
                  </div>
                  <span class="wf-dur mono">{{ r.span.durationMs | dur }}</span>
                </div>
              }
              <p class="keys muted small"><kbd>↑</kbd> <kbd>↓</kbd> parcourir · <kbd>←</kbd> <kbd>→</kbd> replier, déplier · <kbd>Échap</kbd> fermer le détail</p>
            </section>

            @if (selected(); as s) {
              <aside class="panel detail" animate.enter="detail-in" animate.leave="detail-out" aria-label="Détail du span">
                <div class="panel-head">
                  <i class="svc-dot" [style.background]="colorOf(s.service)"></i>
                  <strong class="mono ellipsis" [title]="s.name">{{ s.name }}</strong>
                  <span class="spacer"></span>
                  <button class="btn ghost square" (click)="selected.set(null)" title="Fermer (Échap)" aria-label="Fermer le détail"><wl-nav-icon name="close" [size]="15" /></button>
                </div>
                <div class="detail-body">
                  <div class="pills">
                    <span class="pill"><wl-nav-icon [name]="kindIcon(s.kind)" [size]="12" />{{ kind(s.kind) }}</span>
                    <span class="st" [attr.data-s]="s.statusCode"><i></i>{{ statusText(s) }}</span>
                    <span class="pill"><wl-nav-icon name="timer" [size]="12" />{{ s.durationMs | dur }}</span>
                    <span class="pill" title="Part de la durée totale de la trace">{{ share(s) }} % de la trace</span>
                  </div>
                  <table class="ctx">
                    <tr><td>Service</td><td><span class="svc-inline"><i class="svc-dot" [style.background]="colorOf(s.service)"></i>{{ s.service }}</span></td></tr>
                    @if (s.host) { <tr><td>Hôte</td><td>{{ s.host }}</td></tr> }
                    <tr><td>Type</td><td>{{ kind(s.kind) }}</td></tr>
                    <tr><td>Durée</td><td>{{ s.durationMs | dur }} <span class="muted">· débute à +{{ offsetLabel(s) }}</span></td></tr>
                    <tr><td>Début</td><td class="mono" [title]="fullDate(s.ts)">{{ s.ts | time: true }}</td></tr>
                    <tr><td>Statut</td><td [class.danger]="s.statusCode === 2">{{ statusText(s) }} {{ s.statusMessage ?? '' }}</td></tr>
                    <tr><td>Span</td><td class="mono">{{ s.spanId }} <wl-copy [text]="s.spanId" /></td></tr>
                    @if (parentOf(s); as p) {
                      <tr><td>Parent</td><td>
                        <button type="button" class="link mono" (click)="selectSpan(p)" [title]="'Sélectionner le span parent : ' + p.name"><wl-nav-icon name="arrow-up" [size]="12" />{{ p.name }}</button>
                      </td></tr>
                    }
                    <tr><td>Source</td><td class="mono">{{ s.scope ?? '–' }}</td></tr>
                  </table>
                  @if (isHttp(s)) {
                    <h3>Échange HTTP</h3>
                    <wl-http-exchange [attributes]="s.attributes" />
                  }
                  <h3>Attributs</h3>
                  <wl-attributes [json]="s.attributes" [hideHttp]="true" />
                  @if (spanEvents().length) {
                    <h3>Événements <span class="count">{{ spanEvents().length }}</span></h3>
                    @for (e of spanEvents(); track $index) {
                      <div class="event" [class.exc]="e.name === 'exception'">
                        <div class="ev-head">
                          <wl-nav-icon [name]="e.name === 'exception' ? 'warning' : 'bolt'" [size]="13" />
                          <span class="mono">{{ e.name }}</span>
                          <span class="muted small mono" [title]="fullDate(e.ts)">{{ e.ts | time }}</span>
                        </div>
                        @if (e.name === 'exception') {
                          @if (e.attributes['exception.type']) {
                            <div class="exc-type mono">
                              <strong>{{ e.attributes['exception.type'] }}</strong>@if (e.attributes['exception.message']) {<span>: {{ e.attributes['exception.message'] }}</span>}
                            </div>
                          }
                          @if (e.attributes['exception.stacktrace']) {
                            <pre class="stack">{{ e.attributes['exception.stacktrace'] }}</pre>
                          } @else if (!e.attributes['exception.type']) {
                            <pre class="stack">{{ e.attributes['exception.message'] }}</pre>
                          }
                        } @else {
                          <wl-attributes [json]="stringify(e.attributes)" />
                        }
                      </div>
                    }
                  }
                  <h3>Logs du span <span class="count">{{ selectedLogs().length }}</span></h3>
                  @for (l of selectedLogs(); track $index) {
                    <div class="log"><span class="mono muted small" [title]="fullDate(l.ts)">{{ l.ts | time }}</span><wl-level [level]="l.level" /><span class="mono">{{ l.body }}</span></div>
                  } @empty {
                    <div class="empty small">Aucun log émis dans ce span.</div>
                  }
                </div>
              </aside>
            }
          </div>

          <section class="panel">
            <div class="panel-head">
              <h2>Logs de la trace</h2><span class="count">{{ d.logs.length }}</span>
              <span class="spacer"></span>
              @if (d.logs.length) { <span class="muted small hide-narrow">Cliquer un log sélectionne son span</span> }
            </div>
            @for (l of d.logs; track $index) {
              <div class="logrow" [class.click]="spanById().has(l.spanId ?? '')" [class.sel]="!!l.spanId && l.spanId === selected()?.spanId" (click)="selectSpanOf(l)">
                <span class="mono small muted" [title]="fullDate(l.ts)">{{ l.ts | time }}</span>
                <wl-level [level]="l.level" />
                <span class="small ellipsis svc-cell" [title]="l.service"><i class="svc-dot" [style.background]="colorOf(l.service)"></i>{{ l.service }}</span>
                <span class="mono ellipsis">{{ l.body }}</span>
              </div>
            } @empty {
              <div class="empty">Aucun log rattaché à cette trace.</div>
            }
          </section>
        }
      } @else if (loadError()) {
        <div class="panel empty">
          <p class="lead-text">{{ loadError() }}</p>
          <p class="hint">Vérifiez la connexion au serveur, puis réessayez.</p>
          <div class="cta"><button class="btn" (click)="fetch()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button></div>
        </div>
      } @else if (loading()) {
        <div class="panel"><wl-skeleton [rows]="2" /></div>
        <div class="panel"><wl-skeleton [rows]="10" /></div>
      }
    </div>
  `,
  styles: `
    .crumb { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); transition: color .2s; }
    .crumb:hover { color: var(--accent); text-decoration: none; }
    .crumb wl-nav-icon { transition: transform .4s var(--spring); }
    .crumb:hover wl-nav-icon { transform: scale(1.15) rotate(-8deg); }
    .sep { color: var(--text-3); }
    h1 { max-width: 50vw; }
    .trace-id { display: inline-flex; align-items: center; gap: 6px; max-width: 360px; min-width: 0; padding: 3px 4px 3px 10px; border-radius: 999px;
      color: var(--text-3); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .trace-id .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
    .page-head .btn wl-nav-icon { transition: transform .4s var(--spring); }
    .page-head .btn:hover wl-nav-icon { transform: scale(1.12) rotate(-8deg); }
    .facts { display: flex; flex-wrap: wrap; align-items: stretch; }
    .facts > div { display: grid; gap: 2px; align-content: start; padding: 10px 16px; border-right: 1px solid var(--border-soft); }
    .facts > div > span { font-size: 11.5px; color: var(--text-3); }
    .facts strong { font-weight: 600; }
    .facts strong.big { font-size: 18px; letter-spacing: -.01em; }
    .facts .legend { display: flex; flex-wrap: wrap; gap: 6px; align-content: center; border-right: 0; margin-left: auto; max-width: 52%; font-size: 12px; color: var(--text-2); }
    .svc { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 8px; border-radius: 999px; border: 1px solid var(--border-soft);
      background: var(--surface-2); cursor: default; outline: none; transition: border-color .2s, background-color .2s, transform .3s var(--spring); }
    .svc:hover, .svc.on, .svc:focus-visible { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--surface-3); transform: translateY(-1px); }
    .svc i { width: 8px; height: 8px; border-radius: 50%; }
    .svc .n { font: 600 10.5px var(--mono); color: var(--text-3); }
    .svc-dot { flex: none; display: inline-block; width: 8px; height: 8px; border-radius: 3px; }
    .split { position: relative; display: grid; gap: 14px; }
    .split.with-detail { grid-template-columns: minmax(0, 1fr) minmax(420px, 44%); }
    .waterfall { overflow: hidden; }
    .wf-head, .wf-row { display: grid; grid-template-columns: minmax(220px, 34%) 1fr 80px; }
    .wf-head { border-bottom: 1px solid var(--border); padding: 7px 0; font-size: 11px; }
    .wf-head > span { padding-left: 12px; }
    .ticks { position: relative; }
    .wf-head .r { text-align: right; padding-right: 12px; }
    .ticks span { position: absolute; white-space: nowrap; }
    .wf-row { height: 26px; align-items: center; cursor: pointer; border-bottom: 1px solid var(--border-soft); transition: background-color .15s, opacity .25s; }
    .wf-row:hover { background: var(--row-hover); }
    .wf-row.sel { background: var(--row-selected); box-shadow: inset 2px 0 0 var(--accent); }
    .wf-row.dim { opacity: .3; }
    .wf-name { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; padding-right: 8px; }
    .wf-row.err .name { color: var(--danger); }
    .twist { flex: none; display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 5px; background: none;
      color: var(--text-3); cursor: pointer; transition: color .2s, background-color .2s; }
    .twist:hover { color: var(--accent); background: var(--accent-soft); }
    .twist wl-nav-icon { transition: transform .35s var(--spring); }
    .twist.closed wl-nav-icon { transform: rotate(-90deg); }
    .twist-gap { flex: none; width: 18px; }
    .hidden-count { flex: none; padding: 0 6px; border-radius: 999px; font: 600 10px/15px var(--mono); color: var(--text-2); background: var(--surface-3); }
    .wf-track { position: relative; height: 100%; margin-right: 8px; border-left: 1px solid var(--border-soft);
      background: linear-gradient(90deg, var(--border-soft) 1px, transparent 1px) 0 0 / 25% 100%; }
    .wf-bar { position: absolute; top: 7px; height: 12px; min-width: 2px; border-radius: 4px; opacity: .85; transform-origin: left; transition: opacity .2s; }
    /* Barres qui grandissent en cascade : premières lignes seulement (une trace peut compter des centaines de spans). */
    .wf-row:nth-child(-n+15) .wf-bar { animation: bar-in .6s var(--ease) backwards; animation-delay: calc(var(--i) * 22ms + 80ms); }
    .wf-row:hover .wf-bar, .wf-row.sel .wf-bar { opacity: 1; }
    .wf-bar.err { background: var(--danger); }
    @keyframes bar-in { from { transform: scaleX(0); opacity: 0; } }
    .wf-dur { text-align: right; padding-right: 12px; font-size: 11.5px; color: var(--text-2); white-space: nowrap; }
    .keys { margin: 0; padding: 8px 12px; }
    .detail { display: flex; flex-direction: column; max-height: calc(100vh - 120px); position: sticky; top: 60px; overflow: hidden; }
    .detail .panel-head { flex: none; }
    .detail-body { overflow: auto; padding: 12px; min-height: 0; }
    .detail-body > * + * { margin-top: 8px; }
    .detail-in { animation: detail-in .38s var(--ease) backwards; }
    .detail-out { animation: detail-out .2s ease-in forwards; }
    @keyframes detail-in { from { opacity: 0; transform: translateX(24px); } }
    @keyframes detail-out { to { opacity: 0; transform: translateX(24px); } }
    @media (min-width: 1201px) { .split > .detail-out { position: absolute; top: 0; right: 0; width: 44%; min-width: 420px; } }
    .btn.square { width: 30px; height: 30px; padding: 0; justify-content: center; }
    .pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px;
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .st { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
      color: var(--tone, var(--text-3)); background: color-mix(in srgb, var(--tone, var(--text-3)) 12%, transparent); }
    .st i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .st[data-s='1'] { --tone: var(--ok); }
    .st[data-s='2'] { --tone: var(--danger); }
    .ctx { font-size: 12px; border-collapse: collapse; width: 100%; table-layout: fixed; }
    .ctx td { padding: 3px 16px 3px 0; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--border-soft); }
    .ctx tr:last-child td { border-bottom: 0; }
    .ctx td:first-child { width: 110px; color: var(--text-3); white-space: nowrap; }
    .svc-inline { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
    .link { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 0; border: 0; background: none; color: var(--accent);
      font-size: 12px; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
    .link:hover { text-decoration: underline; text-underline-offset: 3px; }
    .link wl-nav-icon { transition: transform .35s var(--spring); }
    .link:hover wl-nav-icon { transform: translateY(-2px); }
    h3 { display: flex; align-items: center; gap: 6px; margin-top: 14px !important; }
    .count { min-width: 18px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/17px var(--mono); text-align: center; letter-spacing: 0; text-transform: none;
      color: var(--text-2); background: var(--surface-3); }
    .event { display: grid; gap: 6px; padding: 8px 10px; font-size: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-soft); background: var(--surface-2); }
    .event.exc { border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 6%, transparent); }
    .ev-head { display: flex; align-items: center; gap: 8px; }
    .ev-head wl-nav-icon { color: var(--accent); }
    .event.exc .ev-head wl-nav-icon { color: var(--danger); }
    .ev-head .small { margin-left: auto; }
    .exc-type { color: var(--text-1); overflow-wrap: anywhere; }
    .exc-type strong { color: var(--danger); }
    .log { display: grid; grid-template-columns: 84px 30px minmax(0, 1fr); gap: 8px; align-items: center; padding: 3px 0; font-size: 12px;
      border-bottom: 1px solid var(--border-soft); }
    .log .mono:last-child { overflow-wrap: anywhere; }
    .empty.small { padding: 10px 0; text-align: left; }
    .logrow { display: grid; grid-template-columns: 100px 30px 140px minmax(0, 1fr); gap: 12px; align-items: center; padding: 4px 12px;
      border-bottom: 1px solid var(--border-soft); font-size: 12.5px; transition: background-color .15s; }
    .logrow:last-child { border-bottom: 0; }
    .svc-cell .svc-dot { margin-right: 7px; }
    .logrow.click { cursor: pointer; }
    .logrow.click:hover { background: var(--row-hover); }
    .logrow.sel { background: var(--row-selected); box-shadow: inset 2px 0 0 var(--accent); }
    .empty .lead-text { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 550; }
    .empty .hint { max-width: 460px; margin: 6px auto 0; font-size: 12.5px; }
    .cta { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    @media (max-width: 1200px) {
      .split.with-detail { grid-template-columns: 1fr; }
      .detail { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100%); max-height: none; z-index: 60; border-radius: 0; box-shadow: var(--shadow-pop); }
      .hide-narrow { display: none; }
    }
  `,
})
export class TraceDetailPage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly id = input.required<string>();
  readonly around = input<string | null>(null);
  /** Span à ouvrir directement (lien depuis la page Requêtes HTTP). */
  readonly span = input<string | null>(null);
  protected readonly detail = signal<TraceDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly selected = signal<SpanItem | null>(null);
  /** Spans repliés (leurs descendants sont masqués). */
  protected readonly collapsed = signal(new Set<string>());
  /** Service survolé dans la légende : ses spans ressortent, les autres s'estompent. */
  protected readonly focusService = signal<string | null>(null);
  protected readonly max = Math.max;
  protected readonly min = Math.min;

  protected readonly services = computed(() => {
    const counts = new Map<string, number>();
    for (const s of this.detail()?.spans ?? []) counts.set(s.service, (counts.get(s.service) ?? 0) + 1);
    return [...counts].map(([name, count], i) => ({ name, count, color: paletteColor(i) }));
  });
  private readonly serviceColors = computed(() => new Map(this.services().map((s) => [s.name, s.color])));
  protected readonly spanById = computed(() => new Map((this.detail()?.spans ?? []).map((s) => [s.spanId, s])));

  private readonly start = computed(() => Math.min(...(this.detail()?.spans ?? []).map((s) => new Date(s.ts).getTime())));

  protected readonly totalMs = computed(() => {
    const spans = this.detail()?.spans ?? [];
    if (!spans.length) return 1;
    const end = Math.max(...spans.map((s) => new Date(s.ts).getTime() + s.durationMs));
    return Math.max(end - this.start(), 0.001);
  });

  protected readonly errorCount = computed(() => (this.detail()?.spans ?? []).filter((s) => s.statusCode === 2).length);

  /** Ordre de l'arbre : parent puis enfants par date de début ; les descendants d'un span replié sont omis. */
  protected readonly rows = computed<Row[]>(() => {
    const spans = this.detail()?.spans ?? [];
    const colors = this.serviceColors();
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
    const descendants = (s: SpanItem): number => (children.get(s.spanId) ?? []).reduce((n, c) => n + 1 + descendants(c), 0);
    const collapsed = this.collapsed();
    const out: Row[] = [];
    const start = this.start();
    const visit = (s: SpanItem, depth: number) => {
      const kids = (children.get(s.spanId) ?? []).sort(byStart);
      const closed = kids.length > 0 && collapsed.has(s.spanId);
      out.push({
        span: s, depth, offsetMs: new Date(s.ts).getTime() - start, color: colors.get(s.service) ?? '#888',
        children: kids.length, hidden: closed ? descendants(s) : 0,
      });
      if (!closed) for (const c of kids) visit(c, depth + 1);
    };
    for (const r of roots.sort(byStart)) visit(r, 0);
    return out;
  });

  protected readonly ticks = computed(() => {
    const total = this.totalMs();
    return [0, 0.25, 0.5, 0.75].map((f) => ({ pct: f * 100, label: f === 0 ? '0' : formatTick(total * f) }));
  });

  /** Événements et logs du span sélectionné (analysés une fois par sélection). */
  protected readonly spanEvents = computed<SpanEvent[]>(() => {
    const s = this.selected();
    if (!s) return [];
    try { return JSON.parse(s.events) ?? []; } catch { return []; }
  });
  protected readonly selectedLogs = computed(() => {
    const id = this.selected()?.spanId;
    return id ? (this.detail()?.logs ?? []).filter((l) => l.spanId === id) : [];
  });

  constructor() {
    effect(() => {
      this.id();
      this.around();
      untracked(() => this.fetch());
    });
  }

  protected fetch() {
    const id = this.id();
    this.loading.set(true);
    this.loadError.set('');
    this.api.trace(id, this.around()).subscribe({
      next: (d) => {
        if (id !== this.id()) return;
        this.detail.set(d);
        this.collapsed.set(new Set());
        this.loading.set(false);
        // Span demandé, sinon le premier en erreur, sinon la racine : le détail est visible sans clic.
        const wanted = this.span();
        const byId = wanted ? d.spans.find((x) => x.spanId === wanted) : undefined;
        const failed = d.spans.find((x) => x.statusCode === 2 && x.kind === 2) ?? d.spans.find((x) => x.statusCode === 2);
        const root = d.spans.find((x) => !x.parentSpanId || !d.spans.some((p) => p.spanId === x.parentSpanId));
        this.selected.set(byId ?? failed ?? root ?? null);
      },
      error: () => {
        if (id !== this.id()) return;
        this.loading.set(false);
        this.detail.set(null);
        this.selected.set(null);
        this.loadError.set('Impossible de charger la trace.');
      },
    });
  }

  kind(k: number) { return KINDS[k] ?? '–'; }

  protected kindIcon(k: number) { return KIND_ICONS[k] ?? 'layers'; }

  protected statusText(s: SpanItem) { return s.statusCode === 2 ? 'erreur' : s.statusCode === 1 ? 'ok' : 'non défini'; }

  isHttp(s: SpanItem) { return s.attributes.includes('"http.request.method"'); }

  stringify(v: unknown) { return JSON.stringify(v); }

  protected colorOf(service: string) {
    return this.serviceColors().get(service) ?? 'var(--text-3)';
  }

  protected parentOf(s: SpanItem) {
    return s.parentSpanId ? (this.spanById().get(s.parentSpanId) ?? null) : null;
  }

  /** Part de la durée totale de la trace, en pourcentage. */
  protected share(s: SpanItem) {
    return ((s.durationMs / this.totalMs()) * 100).toLocaleString('fr-FR', { maximumFractionDigits: s.durationMs / this.totalMs() >= 0.1 ? 0 : 1 });
  }

  protected offsetLabel(s: SpanItem) {
    return formatTick(new Date(s.ts).getTime() - this.start());
  }

  protected barTip(r: Row) {
    return `${r.span.name}\n${formatDuration(r.span.durationMs)}, débute à +${formatTick(r.offsetMs)}`;
  }

  /** Date et heure complètes, en infobulle des heures abrégées. */
  protected fullDate(iso: string) {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
  }

  protected toggleSpan(s: SpanItem) {
    this.selected.set(this.selected() === s ? null : s);
  }

  /** Sélectionne un span (dépliant au besoin ses ancêtres) et l'amène dans la vue. */
  protected selectSpan(s: SpanItem) {
    const ancestors = new Set<string>();
    for (let p = this.parentOf(s), guard = 0; p && guard < 500; p = this.parentOf(p), guard++) ancestors.add(p.spanId);
    if ([...ancestors].some((id) => this.collapsed().has(id))) {
      this.collapsed.set(new Set([...this.collapsed()].filter((id) => !ancestors.has(id))));
    }
    this.selected.set(s);
    afterNextRender(() => this.host.querySelector('.wf-row.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), { injector: this.injector });
  }

  protected selectSpanOf(l: LogItem) {
    const s = l.spanId ? this.spanById().get(l.spanId) : undefined;
    if (s) this.selectSpan(s);
  }

  /** Replie ou déplie un span ; s'il masque le span sélectionné, la sélection remonte sur lui. */
  protected setCollapsed(s: SpanItem, closed: boolean) {
    const next = new Set(this.collapsed());
    if (closed) next.add(s.spanId);
    else next.delete(s.spanId);
    this.collapsed.set(next);
    const sel = this.selected();
    if (closed && sel && sel !== s) {
      for (let p = this.parentOf(sel), guard = 0; p && guard < 500; p = this.parentOf(p), guard++) {
        if (p.spanId === s.spanId) {
          this.selected.set(s);
          break;
        }
      }
    }
  }

  /** Échap : fermer le détail ; ↑ ↓ : span précédent / suivant ; ← → : replier / déplier (ou remonter au parent). */
  protected onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      this.selected.set(null);
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const rows = this.rows();
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.span === this.selected());
    const row = rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      this.selected.set(rows[next].span);
      afterNextRender(() => this.host.querySelectorAll('.wf-row')[next]?.scrollIntoView({ block: 'nearest' }), { injector: this.injector });
    } else if (row && e.key === 'ArrowRight') {
      e.preventDefault();
      if (row.hidden) this.setCollapsed(row.span, false);
      else if (row.children && rows[i + 1]) this.selected.set(rows[i + 1].span);
    } else if (row && e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row.children && !row.hidden) this.setCollapsed(row.span, true);
      else {
        const parent = this.parentOf(row.span);
        if (parent) this.selectSpan(parent);
      }
    }
  }

  protected readonly parseJson = parseJson;
}

function formatTick(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
