import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { HttpQuery, HttpRequestItem, HttpSummary, LogItem, MetricData, Panel, SpanItem } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { DurPipe } from '../core/pipes/dur-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { Chart, ChartSeries } from '../shared/chart';
import { AddToDashboard } from '../shared/add-to-dashboard';
import { HttpExchange } from '../shared/http-exchange';
import { CopyText } from '../shared/copy-text';
import { CountUp } from '../shared/count-up';
import { LevelBadge } from '../shared/level-badge';
import { NavIcon } from '../shared/nav-icon';
import { SavedSearches } from '../shared/saved-searches';
import { Skeleton } from '../shared/skeleton';

const STATUS_COLORS: Record<string, string> = { '2': '#5a6780', '3': '#7aa2f7', '4': '#c9973f', '5': '#d45f5f' };

@Component({
  selector: 'wl-requests',
  imports: [FormsModule, RouterLink, Chart, DurPipe, NumPipe, TimePipe, AddToDashboard, HttpExchange, LevelBadge, CopyText, SavedSearches, NavIcon, CountUp, Skeleton],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Requêtes HTTP</h1>
        <div class="seg icons">
          <button [class.on]="direction() === 'in'" (click)="direction.set('in')" title="Requêtes reçues par vos services"><wl-nav-icon name="server" [size]="13" />Reçues</button>
          <button [class.on]="direction() === 'out'" (click)="direction.set('out')" title="Appels HTTP émis par vos services (API externes, autres services)"><wl-nav-icon name="globe" [size]="13" />Sortantes</button>
        </div>
        <div class="seg icons">
          @for (s of statuses; track s.value) {
            <button [class.on]="status() === s.value" (click)="status.set(s.value)" [title]="s.hint">{{ s.label }}</button>
          }
        </div>
        <div class="find">
          <wl-nav-icon name="search" [size]="14" class="find-icon" />
          <input [ngModel]="text()" (ngModelChange)="typed($event)" [placeholder]="direction() === 'in' ? 'Route ou chemin, ex. /api/orders' : 'Hôte ou URL'" class="q" aria-label="Filtrer" />
          @if (text()) {
            <button type="button" class="clear" (click)="clearText()" title="Effacer le filtre" aria-label="Effacer le filtre"><wl-nav-icon name="close" [size]="12" /></button>
          }
        </div>
        <div class="find">
          <wl-nav-icon name="timer" [size]="14" class="find-icon" />
          <input [ngModel]="minMs()" (ngModelChange)="minMs.set($event || null)" type="number" min="0" placeholder="Plus lentes que (ms)" class="min" aria-label="Durée minimale" />
        </div>
        <span class="spacer"></span>
        <wl-saved-searches page="requests" [params]="searchParams()" (apply)="applySaved($event)" />
        <wl-add-to-dashboard [panel]="panelForView()" />
      </div>

      @if (summary(); as s) {
        <div class="panel facts">
          <div><span class="lbl"><wl-nav-icon name="hash" [size]="12" />Requêtes</span><strong [wlCountUp]="s.count | num"></strong></div>
          <div><span class="lbl"><wl-nav-icon name="gauge" [size]="12" />Débit</span><strong [wlCountUp]="(s.ratePerSecond | num) + ' /s'"></strong></div>
          <div class="click" [class.on]="status() === 'errors'" role="button" tabindex="0" (click)="status.set('errors')" (keydown.enter)="status.set('errors')"
               title="Afficher les requêtes en erreur">
            <span class="lbl"><wl-nav-icon name="errors" [size]="12" />Erreurs (5xx)</span>
            <strong [class.danger]="s.errors > 0" [wlCountUp]="s.errors | num"></strong>
            <em>{{ s.errorRate | num }} %<wl-nav-icon name="arrow-right" [size]="11" class="go-arrow" /></em>
          </div>
          <div><span class="lbl"><wl-nav-icon name="timer" [size]="12" />Médiane</span><strong [wlCountUp]="s.p50Ms | dur"></strong></div>
          <div><span class="lbl">p95</span><strong [wlCountUp]="s.p95Ms | dur"></strong></div>
          <div><span class="lbl">p99</span><strong [wlCountUp]="s.p99Ms | dur"></strong></div>
          @if (s.count) {
            <div class="export"><span class="lbl">Exporter la liste</span>
              <strong class="links">
                <a class="chip" [href]="exportUrl('csv')" download (click)="exported('CSV')" title="Jusqu'à 10 000 requêtes, séparateur point-virgule (Excel)"><wl-nav-icon name="download" [size]="12" />CSV</a>
                <a class="chip" [href]="exportUrl('json')" download (click)="exported('JSON')" title="Jusqu'à 10 000 requêtes"><wl-nav-icon name="download" [size]="12" />JSON</a>
              </strong>
            </div>
            @if (session.canEdit() && direction() === 'in') {
              <div class="alert-link"><span class="lbl">Être prévenu</span>
                <strong class="links"><a class="chip" routerLink="/alerts/new" [queryParams]="alertParams()" title="Alerte sur le taux d'erreur de ces requêtes"><wl-nav-icon name="bell" [size]="12" />Créer une alerte</a></strong>
              </div>
            }
          }
        </div>
      }

      @if (series(); as d) {
        <div class="panel chart-panel">
          <wl-chart [times]="d.times" [series]="chartSeries()" kind="bars" [stacked]="true" [height]="96" unit="req/s" (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
        </div>
      }

      <div class="split" [class.with-detail]="selected()">
        <section class="panel list-panel">
          @if (items().length) {
            <table class="list">
              <thead>
                <tr>
                  <th class="hide-sm">Date</th><th>Méthode</th><th>{{ direction() === 'in' ? 'Route' : 'Hôte' }}</th><th class="hide-detail hide-sm">Chemin</th><th class="hide-detail hide-sm">Service</th>
                  <th class="r">Statut</th><th class="r">Durée</th><th class="go"></th>
                </tr>
              </thead>
              <tbody>
                @for (r of items(); track r.spanId) {
                  <tr class="click" [class.sel]="r === selected()" [class.failed]="r.error || (r.status ?? 0) >= 500" (click)="select(r)">
                    <td class="mono small muted nowrap hide-sm" [title]="fullDate(r.ts)">{{ r.ts | time: true }}</td>
                    <td><span class="method" [attr.data-m]="r.method">{{ r.method }}</span></td>
                    <td class="mono ellipsis route" [title]="r.target">
                      {{ r.route ?? r.target }}@if (r.hasBody) { <wl-nav-icon name="file" [size]="11" class="has-body" title="Corps de la requête ou de la réponse enregistré" /> }
                    </td>
                    <td class="mono ellipsis target muted hide-detail hide-sm" [title]="r.target">{{ r.target }}</td>
                    <td class="nowrap hide-detail hide-sm">{{ r.service }}</td>
                    <td class="r"><span class="status" [attr.data-c]="tone(r)">{{ r.status ?? '–' }}</span></td>
                    <td class="r mono nowrap" [class.slow]="isSlow(r)" [title]="isSlow(r) ? 'Plus lente que 95 % des requêtes de la période' : ''">{{ r.durationMs | dur }}</td>
                    <td class="go"><wl-nav-icon name="chevron-right" [size]="14" /></td>
                  </tr>
                }
              </tbody>
            </table>
          } @else if (!loading() || loadError()) {
            <div class="empty">
              <p class="lead-text">{{ loadError() || (direction() === 'out' ? 'Aucun appel sortant sur cette période.' : 'Aucune requête sur cette période.') }}</p>
              <p class="hint">
                @if (loadError()) { Vérifiez la connexion au serveur, puis réessayez. }
                @else if (filtered()) { Essayez une autre route, un autre code de statut ou une durée minimale plus faible. }
                @else if (direction() === 'out') { Les appels sortants apparaissent quand vos services instrumentent leur client HTTP. }
                @else { Les requêtes apparaissent dès que vos services envoient leurs spans HTTP serveur. }
              </p>
              <div class="cta">
                @if (loadError()) {
                  <button class="btn" (click)="load()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button>
                } @else if (filtered()) {
                  <button class="btn" (click)="resetFilters()"><wl-nav-icon name="close" [size]="14" />Effacer les filtres</button>
                }
                @if (!loadError() && canWiden()) {
                  <button class="btn ghost" (click)="state.setRelative('24h')"><wl-nav-icon name="calendar" [size]="14" />Élargir à 24 h</button>
                }
              </div>
            </div>
          } @else {
            <wl-skeleton [rows]="9" />
          }
        </section>

        @if (selected(); as r) {
          <aside class="panel detail" animate.enter="detail-in" animate.leave="detail-out" aria-label="Détail de la requête">
            <div class="panel-head">
              <span class="method" [attr.data-m]="r.method">{{ r.method }}</span>
              <strong class="mono ellipsis" [title]="r.target">{{ r.route ?? r.target }}</strong>
              <span class="spacer"></span>
              <span class="muted small hide-narrow"><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Échap</kbd></span>
              <button class="btn ghost square" (click)="selected.set(null)" title="Fermer (Échap)" aria-label="Fermer le détail"><wl-nav-icon name="close" [size]="15" /></button>
            </div>
            <div class="detail-body">
              <div class="meta small">
                <span class="pill" [title]="fullDate(r.ts)"><wl-nav-icon name="clock" [size]="12" />{{ r.ts | time: true }}</span>
                <span class="pill"><wl-nav-icon name="server" [size]="12" />{{ r.service }}</span>
                <span class="status" [attr.data-c]="tone(r)">{{ r.status ?? '–' }}</span>
                <span class="pill" [class.slow]="isSlow(r)"><wl-nav-icon name="timer" [size]="12" />{{ r.durationMs | dur }}</span>
                <span class="mono muted trace-id" [title]="r.traceId">trace {{ r.traceId.slice(0, 12) }}… <wl-copy [text]="r.traceId" /></span>
                <span class="spacer"></span>
                <a class="btn go-trace" [routerLink]="['/traces', r.traceId]" [queryParams]="{ around: r.ts, span: r.spanId }">
                  <wl-nav-icon name="traces" [size]="14" />Trace complète<wl-nav-icon name="arrow-right" [size]="13" class="arrow" />
                </a>
              </div>
              @if (span(); as s) {
                <wl-http-exchange [attributes]="s.attributes" />
                <h3>Logs de la requête <span class="count">{{ spanLogs().length }}</span></h3>
                @for (l of spanLogs(); track $index) {
                  <div class="log small"><span class="mono muted" [title]="fullDate(l.ts)">{{ l.ts | time }}</span><wl-level [level]="l.level" /><span class="mono">{{ l.body }}</span></div>
                } @empty {
                  <div class="empty small">Aucun log émis pendant cette requête.</div>
                }
              } @else if (detailError()) {
                <div class="detail-error">
                  <wl-nav-icon name="warning" [size]="16" />
                  <span>{{ detailError() }}</span>
                  <button class="btn ghost" (click)="loadDetail(r)"><wl-nav-icon name="refresh" [size]="13" />Réessayer</button>
                </div>
              } @else {
                <wl-skeleton [rows]="7" />
              }
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .seg.icons button { display: inline-flex; align-items: center; gap: 6px; }
    .seg.icons wl-nav-icon { transition: transform .4s var(--spring); }
    .seg.icons button:hover wl-nav-icon { transform: scale(1.15) rotate(-6deg); }
    .find { position: relative; display: flex; align-items: center; }
    .find-icon { position: absolute; left: 11px; z-index: 1; color: var(--text-3); pointer-events: none; transition: color .25s, transform .4s var(--spring); }
    .find:focus-within .find-icon { color: var(--accent); transform: scale(1.1); }
    .q { width: 240px; padding-left: 33px; padding-right: 30px; }
    .min { width: 175px; padding-left: 33px; }
    .clear { position: absolute; right: 6px; z-index: 1; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%;
      background: var(--surface-3); color: var(--text-2); cursor: pointer; animation: pop-in .3s var(--spring); transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .clear:hover { color: var(--text-1); background: var(--accent-soft); transform: rotate(90deg); }
    @keyframes pop-in { from { opacity: 0; transform: scale(.5); } }
    .facts { display: flex; flex-wrap: wrap; }
    .facts > div { display: grid; gap: 2px; align-content: start; padding: 10px 16px; border-right: 1px solid var(--border-soft); min-width: 110px; }
    .facts > div:last-child { border-right: 0; }
    .facts > div.click { cursor: pointer; border-radius: var(--radius-sm); transition: background-color .2s; }
    .facts > div.click:hover, .facts > div.click.on { background: var(--row-hover); }
    .facts > div.click.on { box-shadow: inset 0 -2px 0 var(--danger); }
    .facts .lbl { display: inline-flex; align-items: center; gap: 5px; }
    .facts span, .facts em { font-size: 11.5px; color: var(--text-3); font-style: normal; }
    .facts em { display: inline-flex; align-items: center; gap: 4px; }
    .facts .go-arrow { opacity: 0; transform: translateX(-4px); transition: opacity .2s, transform .3s var(--spring); }
    .facts .click:hover .go-arrow { opacity: 1; transform: none; }
    .facts strong { font-weight: 600; font-size: 16px; letter-spacing: -.01em; }
    .facts .links { display: flex; gap: 6px; font-size: 12px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; font: 550 11.5px var(--sans);
      color: var(--accent); background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      transition: background-color .2s, transform .3s var(--spring); }
    .chip:hover { text-decoration: none; transform: translateY(-1px); background: color-mix(in srgb, var(--accent) 24%, transparent); }
    .chip:active { transform: scale(.95); }
    .chart-panel { padding: 4px 10px 0; }
    .split { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-detail { grid-template-columns: minmax(0, 1fr) minmax(460px, 48%); }
    .with-detail .hide-detail { display: none; }
    .route { max-width: 0; width: 34%; }
    .target { max-width: 0; width: 28%; }
    .has-body { display: inline-flex; margin-left: 6px; color: var(--accent-3); vertical-align: -1px; }
    .method { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 6px; font: 700 10px/1 var(--mono); letter-spacing: .03em;
      color: var(--m, var(--text-2)); background: color-mix(in srgb, var(--m, var(--text-3)) 14%, transparent); }
    .method[data-m='GET'] { --m: var(--accent); }
    .method[data-m='POST'] { --m: var(--ok); }
    .method[data-m='PUT'] { --m: var(--warn); }
    .method[data-m='PATCH'] { --m: var(--accent-3); }
    .method[data-m='DELETE'] { --m: var(--danger); }
    .status { display: inline-flex; align-items: center; justify-content: center; min-width: 38px; height: 20px; padding: 0 7px; border-radius: 999px;
      font: 650 11.5px/1 var(--mono); color: var(--tone, var(--text-3)); background: color-mix(in srgb, var(--tone, var(--text-3)) 12%, transparent); }
    .status[data-c='ok'] { --tone: var(--ok); }
    .status[data-c='redir'] { --tone: var(--accent-3); }
    .status[data-c='warn'] { --tone: var(--warn); }
    .status[data-c='err'] { --tone: var(--danger); }
    .slow { color: var(--warn); font-weight: 600; }
    tr.failed td { background: color-mix(in srgb, var(--danger) 4%, transparent); }
    tr.sel td { background: var(--row-selected); }
    tr.sel td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    .go { width: 28px; padding-left: 0 !important; color: var(--text-3); }
    .go wl-nav-icon { opacity: .35; transition: transform .35s var(--spring), opacity .2s, color .2s; }
    tr:hover .go wl-nav-icon, tr.sel .go wl-nav-icon { opacity: 1; color: var(--accent); transform: translateX(3px); }
    .empty .lead-text { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 550; }
    .empty .hint { max-width: 480px; margin: 6px auto 0; font-size: 12.5px; }
    .empty.small { padding: 10px 0; text-align: left; }
    .cta { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .cta:empty { display: none; }
    .detail { position: sticky; top: 62px; max-height: calc(100vh - 80px); display: flex; flex-direction: column; overflow: hidden; }
    .detail .panel-head { flex: none; }
    .detail-body { overflow: auto; padding: 12px; }
    .detail-body > * + * { margin-top: 10px; }
    .detail-in { animation: detail-in .38s var(--ease) backwards; }
    .detail-out { animation: detail-out .2s ease-in forwards; }
    @keyframes detail-in { from { opacity: 0; transform: translateX(24px); } }
    @keyframes detail-out { to { opacity: 0; transform: translateX(24px); } }
    @media (min-width: 1201px) { .split > .detail-out { position: absolute; top: 0; right: 0; width: 48%; min-width: 460px; } }
    .btn.square { width: 30px; height: 30px; padding: 0; justify-content: center; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; color: var(--text-2);
      background: var(--surface-2); border: 1px solid var(--border-soft); }
    .pill.slow { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
    .trace-id { margin-left: 4px; }
    .meta .btn { height: 28px; }
    .go-trace .arrow { transition: transform .35s var(--spring); }
    .go-trace:hover .arrow { transform: translateX(3px); }
    h3 { display: flex; align-items: center; gap: 6px; margin-top: 16px; }
    .count { min-width: 18px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/17px var(--mono); text-align: center; letter-spacing: 0; text-transform: none;
      color: var(--text-2); background: var(--surface-3); }
    .log { display: grid; grid-template-columns: 90px 30px minmax(0, 1fr); gap: 10px; align-items: center; padding: 3px 0; border-bottom: 1px solid var(--border-soft); }
    .log .mono:last-child { overflow-wrap: anywhere; }
    .detail-error { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm); color: var(--danger);
      background: color-mix(in srgb, var(--danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); }
    .detail-error span { flex: 1; color: var(--text-2); }
    p { margin: 0; }
    .facts .alert-link { border-right: 0; border-left: 1px solid var(--border-soft); }
    .facts .export { margin-left: auto; border-right: 0; border-left: 1px solid var(--border-soft); }
    @media (max-width: 1200px) {
      .split.with-detail { grid-template-columns: minmax(0, 1fr); }
      .detail { position: fixed; top: 0; right: 0; bottom: 0; max-height: none; width: min(640px, 100%); z-index: 60; border-radius: 0; box-shadow: var(--shadow-pop); }
      .hide-narrow { display: none; }
    }
  `,
})
export class RequestsPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly state = inject(AppState);

  /** Paramètre d'URL (recherche globale). */
  readonly q = input<string>('');
  readonly statusParam = input<string>('', { alias: 'status' });
  readonly directionParam = input<string>('', { alias: 'direction' });
  readonly minMsParam = input<string>('', { alias: 'minMs' });

  protected readonly statuses = [
    { value: '', label: 'Toutes', tone: '', hint: 'Tous les codes de statut' },
    { value: '2xx', label: '2xx', tone: 'var(--ok)', hint: 'Succès' },
    { value: '4xx', label: '4xx', tone: 'var(--warn)', hint: 'Erreurs du client : requête invalide, non autorisée, introuvable…' },
    { value: '5xx', label: '5xx', tone: 'var(--danger)', hint: 'Erreurs du serveur' },
    { value: 'errors', label: 'En erreur', tone: 'var(--danger)', hint: 'Requêtes marquées en erreur' },
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
  protected readonly loadError = signal('');
  protected readonly selected = signal<HttpRequestItem | null>(null);
  protected readonly span = signal<SpanItem | null>(null);
  protected readonly spanLogs = signal<LogItem[]>([]);
  protected readonly detailError = signal('');
  private subs: Subscription[] = [];
  private detailSub?: Subscription;

  protected readonly filtered = computed(() => !!(this.text() || this.status() || this.minMs()));
  /** Période relative de moins de 24 h : on propose de l'élargir. */
  protected readonly canWiden = computed(() => this.state.isRelative() && ['5m', '15m', '1h', '6h'].includes(this.state.from()));

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
    const p: Record<string, string> = { kind: 'http', stat: 'errorRate' };
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

  protected clearText() {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.text.set('');
    this.appliedText.set('');
  }

  protected resetFilters() {
    this.text.set('');
    this.appliedText.set('');
    this.status.set('');
    this.minMs.set(null);
  }

  protected exported(format: string) {
    this.toasts.info(`Export ${format} en cours de téléchargement (jusqu'à 10 000 requêtes)`, 'download');
  }

  /** Ton du code de statut : succès, redirection, erreur client, erreur serveur. */
  protected tone(r: HttpRequestItem) {
    const s = r.status ?? 0;
    return r.error || s >= 500 ? 'err' : s >= 400 ? 'warn' : s >= 300 ? 'redir' : s >= 100 ? 'ok' : '';
  }

  /** Plus lente que 95 % des requêtes de la période (sur un échantillon suffisant). */
  protected isSlow(r: HttpRequestItem) {
    const s = this.summary();
    return !!s && s.count >= 20 && s.p95Ms !== null && r.durationMs >= s.p95Ms;
  }

  /** Date et heure complètes, en infobulle des heures abrégées. */
  protected fullDate(iso: string) {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
  }

  protected load() {
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
          this.loadError.set('');
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.loadError.set('Impossible de charger les requêtes.');
        },
      }),
      this.api.requestSummary(r, f).subscribe({ next: (s) => this.summary.set(s), error: () => {} }),
      this.api.requestSeries(r, f, 'rate', 'status').subscribe({ next: (s) => this.series.set(s), error: () => {} }),
    ];
  }

  /** Détail dans le panneau de droite, sans quitter la liste. */
  protected select(r: HttpRequestItem) {
    if (this.selected() === r) {
      this.selected.set(null);
      return;
    }
    this.selected.set(r);
    this.loadDetail(r);
  }

  /** Span et logs de la requête (la trace est rechargée ; une actualisation de la liste ne l'interrompt pas). */
  protected loadDetail(r: HttpRequestItem) {
    this.span.set(null);
    this.spanLogs.set([]);
    this.detailError.set('');
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.trace(r.traceId, r.ts).subscribe({
      next: (t) => {
        if (this.selected()?.spanId !== r.spanId) return;
        const span = t.spans.find((s) => s.spanId === r.spanId) ?? null;
        this.span.set(span);
        this.spanLogs.set(t.logs.filter((l) => l.spanId === r.spanId || (!l.spanId && t.spans.length === 1)));
        if (!span) this.detailError.set('Span introuvable : la trace a peut-être expiré.');
      },
      error: () => {
        if (this.selected()?.spanId === r.spanId) this.detailError.set('Impossible de charger le détail de cette requête.');
      },
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
      this.host.querySelectorAll('tr.click')[next]?.scrollIntoView({ block: 'nearest' });
    }
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
    this.detailSub?.unsubscribe();
    if (this.typingTimer) clearTimeout(this.typingTimer);
  }
}
