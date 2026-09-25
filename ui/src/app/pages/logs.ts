import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { Subscription } from 'rxjs';
import { Api, Histogram, LogItem, Panel } from '../core/api';
import { AppState, Session } from '../core/state';
import { LEVEL_COLORS, LEVELS, NumPipe, TimePipe, parseJson } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';
import { Attributes, CopyText, LevelBadge } from '../shared/widgets';
import { AddToDashboard } from '../shared/add-to-dashboard';
import { SavedSearches } from '../shared/saved-searches';

const LEVEL_FILTERS = [
  { value: '', label: 'Tout' },
  { value: 'info', label: '≥ Info' },
  { value: 'warn', label: '≥ Warn' },
  { value: 'error', label: '≥ Error' },
];

const MAX_LIVE = 5000;
const ROW_HEIGHT = 26;

@Component({
  selector: 'vg-logs',
  imports: [FormsModule, ScrollingModule, Chart, LevelBadge, Attributes, CopyText, NumPipe, TimePipe, RouterLink, AddToDashboard, SavedSearches],
  host: { '(document:keydown)': 'onKey($event)', class: 'fill-host' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page fill">
      <div class="page-head">
        <div class="searchbar">
          <input #searchBox class="search" [ngModel]="query" (ngModelChange)="typed($event)" (keydown.enter)="searchNow()"
                 placeholder='Rechercher : timeout  service:api  http.route:/users/*  "texte exact"  -exclure' aria-label="Recherche" />
          @if (query) { <button class="clear" (click)="clear()" title="Effacer">Effacer</button> }
          <kbd class="shortcut">/</kbd>
        </div>
        <div class="seg">
          @for (l of levelFilters; track l.value) {
            <button [class.on]="level() === l.value" (click)="level.set(l.value)">{{ l.label }}</button>
          }
        </div>
        <button class="btn" [class.on]="live()" (click)="toggleLive()">{{ live() ? 'Arrêter le direct' : 'Suivre en direct' }}</button>
        <vg-saved-searches page="logs" [params]="searchParams()" (apply)="applySaved($event)" />
        <vg-add-to-dashboard [panel]="panelForSearch()" />
      </div>

      @if (!live()) {
        <div class="panel chart-panel">
          <vg-chart [times]="histTimes()" [series]="histSeries()" kind="bars" [stacked]="true" [height]="84" [legend]="false" (rangeSelect)="zoom($event)" />
        </div>
      }

      <div class="split grow" [class.with-detail]="selected()">
        <section class="panel results">
          <div class="panel-head small">
            @if (live()) {
              <span><span class="live-dot"></span>{{ items().length | num }} logs reçus depuis l'ouverture du flux</span>
            } @else {
              <span><strong>{{ total() | num }}</strong> logs</span>
              @if (stats(); as s) { <span class="muted">{{ s.elapsedMs }} ms</span> }
            }
            <span class="spacer"></span>
            @if (error()) { <span class="danger">{{ error() }}</span> }
            @else if (items().length) { <span class="muted hide-narrow">Clic ou <kbd>↑</kbd> <kbd>↓</kbd> pour le détail</span> }
            @if (!live() && items().length) {
              <span class="export">Exporter
                <a [href]="exportUrl('csv')" download title="Jusqu'à 10 000 logs, séparateur point-virgule (Excel)">CSV</a>
                <a [href]="exportUrl('json')" download title="Jusqu'à 10 000 logs">JSON</a>
              </span>
              @if (session.canEdit()) {
                <a routerLink="/alerts/new" [queryParams]="alertParams()" title="Être prévenu quand des logs correspondent à cette recherche">Alerter</a>
              }
            }
          </div>
          <cdk-virtual-scroll-viewport [itemSize]="rowHeight" class="viewport" (scrolledIndexChange)="onScroll($event)">
            <div *cdkVirtualFor="let log of items(); trackBy: trackLog" class="row" [class.sel]="log === selected()" (click)="select(log)">
              <span class="ts mono">{{ log.ts | time: true }}</span>
              <vg-level [level]="log.level" />
              <span class="svc ellipsis">{{ log.service }}</span>
              <span class="msg mono ellipsis">@if (log.isCrash) { <span class="tag crash">crash</span> }{{ log.body }}</span>
            </div>
          </cdk-virtual-scroll-viewport>
          @if (!items().length && !loading()) {
            <div class="empty">
              @if (live()) { En attente de nouveaux logs. }
              @else if (query || level()) { Aucun log ne correspond. <a (click)="clear(); level.set('')">Effacer les filtres</a> }
              @else { Aucun log sur cette période. }
            </div>
          }
        </section>

        @if (selected(); as log) {
          <aside class="panel detail">
            <div class="panel-head">
              <vg-level [level]="log.level" />
              <span class="mono small">{{ log.ts | time: true }}</span>
              <span class="spacer"></span>
              <span class="muted small hide-narrow"><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Échap</kbd></span>
              <button class="btn ghost" (click)="selected.set(null)">Fermer</button>
            </div>
            <div class="detail-body">
              <pre class="body">{{ log.body }}</pre>

              <div class="links small">
                @if (log.traceId) {
                  <a class="btn" [routerLink]="['/traces', log.traceId]" [queryParams]="{ around: log.ts, span: log.spanId }">Ouvrir la trace</a>
                }
                @if (log.fingerprint) {
                  <a class="btn" [routerLink]="['/errors', log.fingerprint]">Voir le regroupement d'erreurs</a>
                }
                <span class="muted">Cliquer une valeur l'ajoute au filtre.</span>
              </div>

              @if (log.exceptionType) {
                <h3>Exception</h3>
                <div class="mono small"><strong class="pick" (click)="addFilter('exception', log.exceptionType)">{{ log.exceptionType }}</strong>: {{ log.exceptionMessage }}</div>
                @if (log.exceptionStack) { <pre class="stack">{{ log.exceptionStack }}</pre> }
              }

              @if (breadcrumbs(log).length) {
                <h3>Logs précédant le crash</h3>
                <div class="crumbs mono">
                  @for (c of breadcrumbs(log); track $index) {
                    <div><span class="muted">{{ c.Ts | time }}</span> {{ c.Level }} {{ c.Message }}</div>
                  }
                </div>
              }

              <h3>Contexte</h3>
              <table class="ctx">
                <tr><td>Service</td><td><span class="pick" (click)="addFilter('service', log.service)">{{ log.service }}</span></td></tr>
                @if (log.version) { <tr><td>Version</td><td><span class="pick" (click)="addFilter('version', log.version)">{{ log.version }}</span></td></tr> }
                @if (log.host) { <tr><td>Hôte</td><td><span class="pick" (click)="addFilter('host', log.host)">{{ log.host }}</span></td></tr> }
                @if (log.env) { <tr><td>Environnement</td><td><span class="pick" (click)="addFilter('env', log.env)">{{ log.env }}</span></td></tr> }
                @if (log.category) { <tr><td>Catégorie</td><td class="mono"><span class="pick" (click)="addFilter('category', log.category)">{{ log.category }}</span></td></tr> }
                @if (log.traceId) {
                  <tr><td>Trace</td><td class="mono"><span class="pick" (click)="addFilter('trace', log.traceId)" title="Logs de la même trace">{{ log.traceId }}</span> <vg-copy [text]="log.traceId" /></td></tr>
                }
              </table>

              <h3>Attributs</h3>
              <vg-attributes [json]="log.attributes" [exclude]="['vigil.breadcrumbs']" [pickable]="true" (pick)="addFilter($event.key, $event.value)" />

              <details>
                <summary class="small muted">Ressource (attributs de l'application)</summary>
                <vg-attributes [json]="log.resource" />
              </details>
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    :host { flex: 1 1 0 !important; min-height: 0; }
    .searchbar { position: relative; display: flex; flex: 1; min-width: 320px; }
    .searchbar .search { flex: 1; padding-right: 110px; }
    .clear { position: absolute; right: 34px; top: 4px; height: 20px; border: 0; background: none; color: var(--text-3); font-size: 12px; cursor: pointer; }
    .clear:hover { color: var(--text-1); }
    .shortcut { position: absolute; right: 8px; top: 5px; }
    .export { color: var(--text-3); display: inline-flex; gap: 8px; }
    .chart-panel { padding: 4px 10px 0; }
    .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin-right: 8px; animation: blink 1.4s infinite; }
    @keyframes blink { 50% { opacity: .3; } }
    .split { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 14px; }
    .split.with-detail { grid-template-columns: minmax(0, 1fr) minmax(400px, 42%); }
    .results { display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .results .panel-head { gap: 12px; flex: none; }
    .viewport { flex: 1; min-height: 120px; }
    .row { height: 26px; display: grid; grid-template-columns: 148px 30px 120px minmax(0, 1fr); align-items: center; gap: 12px;
      padding: 0 12px; border-bottom: 1px solid var(--border-soft); cursor: pointer; font-size: 12.5px; }
    .row:hover { background: var(--row-hover); }
    .row.sel { background: var(--row-selected); box-shadow: inset 2px 0 0 var(--accent); }
    .ts { color: var(--text-3); font-size: 12px; }
    .svc { color: var(--text-2); }
    .msg .tag { margin-right: 6px; }
    .empty a { cursor: pointer; }
    .detail { display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .detail .panel-head { flex: none; }
    .detail-body { overflow: auto; padding: 12px; min-height: 0; }
    .detail-body > * + * { margin-top: 10px; }
    .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 var(--mono); }
    .links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .links .btn { height: 26px; }
    h3 { margin-top: 14px; }
    .crumbs { font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; max-height: 220px; overflow: auto; }
    .ctx { font-size: 12px; border-collapse: collapse; width: 100%; table-layout: fixed; }
    .ctx td { padding: 2px 16px 2px 0; vertical-align: top; overflow-wrap: anywhere; }
    .ctx td:first-child { color: var(--text-3); white-space: nowrap; width: 110px; }
    summary { cursor: pointer; margin-top: 14px; }
    @media (max-width: 1200px) {
      .split.with-detail { grid-template-columns: minmax(0, 1fr); }
      .detail { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100%); z-index: 60; border-radius: 0; box-shadow: -12px 0 32px rgba(0, 0, 0, .35); }
      .hide-narrow { display: none; }
    }
  `,
})
export class LogsPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);

  /** Paramètres d'URL (liens partageables). */
  readonly q = input<string>('');
  readonly levelParam = input<string>('', { alias: 'level' });
  readonly level = signal('');

  protected readonly levelFilters = LEVEL_FILTERS;
  protected readonly rowHeight = ROW_HEIGHT;
  protected query = '';
  private readonly appliedQuery = signal('');
  protected readonly items = signal<LogItem[]>([]);
  protected readonly selected = signal<LogItem | null>(null);
  protected readonly histogram = signal<Histogram | null>(null);
  protected readonly stats = signal<{ elapsedMs: number } | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly live = signal(false);
  private nextBefore: string | null = null;
  private loadingMore = false;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private subs: Subscription[] = [];
  private source: EventSource | null = null;
  private readonly viewport = viewChild(CdkVirtualScrollViewport);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');

  /** La recherche courante, sous forme de panneau de tableau de bord. */
  protected readonly panelForSearch = computed<Panel>(() => {
    const q = [this.appliedQuery(), this.level() ? 'level:' + this.level() : ''].filter(Boolean).join(' ');
    return {
      id: '', title: q ? `Logs : ${q}` : 'Logs par niveau', type: 'custom', width: 6, height: 'm',
      dataSource: 'logs', query: q || null, aggregate: 'count', groupBy: 'level', view: 'bars', limit: 10,
      service: this.state.service() || null,
    };
  });

  protected readonly searchParams = computed(() => ({ q: this.appliedQuery(), level: this.level() }));

  protected applySaved(p: Record<string, string>) {
    this.query = p['q'] ?? '';
    this.level.set(p['level'] ?? '');
    this.searchNow();
  }

  protected readonly session = inject(Session);

  protected alertParams() {
    const filter = [this.appliedQuery(), this.level() ? 'level:' + this.level() : ''].filter(Boolean).join(' ');
    const p: Record<string, string> = { kind: 'query', source: 'logs', agg: 'count' };
    if (filter) p['filter'] = filter;
    if (this.state.service()) p['service'] = this.state.service();
    return p;
  }

  protected exportUrl(format: 'csv' | 'json') {
    return this.api.exportUrl('logs', format, {
      ...this.state.range(), q: this.appliedQuery(), level: this.level(), service: this.state.service(), env: this.state.env(),
    });
  }

  protected readonly total = computed(() => {
    const h = this.histogram();
    return h ? h.buckets.reduce((s, b) => s + b.trace + b.debug + b.info + b.warn + b.error + b.fatal, 0) : this.items().length;
  });
  protected readonly histTimes = computed(() => this.histogram()?.buckets.map((b) => b.t) ?? []);
  protected readonly histSeries = computed<ChartSeries[]>(() => {
    const buckets = this.histogram()?.buckets ?? [];
    return LEVELS.map((l) => ({ label: l, color: LEVEL_COLORS[l], values: buckets.map((b) => b[l]) }));
  });

  constructor() {
    // Paramètres d'URL → état initial.
    effect(() => {
      const q = this.q();
      const level = this.levelParam();
      untracked(() => {
        this.query = q ?? '';
        this.appliedQuery.set(this.query.trim());
        if (level) this.level.set(level);
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      this.appliedQuery();
      this.level();
      untracked(() => (this.live() ? this.startLive() : this.load()));
    });
  }

  protected trackLog = (_: number, l: LogItem) => l.ts + l.body.length + l.service;

  /** Recherche pendant la frappe (petit délai pour ne pas lancer une requête par touche). */
  protected typed(value: string) {
    this.query = value;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.searchNow(), 300);
  }

  protected searchNow() {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    const q = this.query.trim();
    if (q === this.appliedQuery()) return;
    this.appliedQuery.set(q);
    this.router.navigate([], { queryParams: { q: q || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected clear() {
    this.query = '';
    this.searchNow();
  }

  addFilter(key: string, value: string) {
    const token = /\s/.test(value) ? `${key}:"${value}"` : `${key}:${value}`;
    if (!this.query.includes(token)) this.query = (this.query + ' ' + token).trim();
    this.searchNow();
  }

  /** "/" : recherche ; ↑ ↓ : log précédent / suivant ; Échap : fermer le détail. */
  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    if (e.key === '/' && !typing) {
      e.preventDefault();
      this.searchBox()?.nativeElement.focus();
    } else if (e.key === 'Escape') {
      if (typing) (target as HTMLInputElement).blur();
      else this.selected.set(null);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && this.items().length) {
      e.preventDefault();
      const list = this.items();
      const current = this.selected() ? list.indexOf(this.selected()!) : -1;
      const next = Math.max(0, Math.min(list.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
      this.selected.set(list[next]);
      this.ensureVisible(next);
    }
  }

  private ensureVisible(index: number) {
    const vp = this.viewport();
    if (!vp) return;
    const top = vp.measureScrollOffset('top');
    const height = vp.getViewportSize();
    const y = index * ROW_HEIGHT;
    if (y < top) vp.scrollToOffset(y);
    else if (y + ROW_HEIGHT > top + height) vp.scrollToOffset(y + ROW_HEIGHT - height);
  }

  zoom(r: { from: Date; to: Date }) {
    this.state.setAbsolute(r.from, r.to);
  }

  select(log: LogItem) {
    this.selected.set(this.selected() === log ? null : log);
  }

  breadcrumbs(log: LogItem): { Ts: string; Level: string; Message: string }[] {
    const raw = parseJson(log.attributes)['vigil.breadcrumbs'];
    if (typeof raw !== 'string') return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  private load() {
    this.subs.forEach((s) => s.unsubscribe());
    this.loading.set(true);
    this.error.set('');
    this.nextBefore = null;
    const r = this.state.range();
    const q = this.appliedQuery();
    const level = this.level();
    const service = this.state.service();
    this.subs = [
      this.api.logs(r, q, level, service).subscribe({
        next: (page) => {
          // On garde le log ouvert s'il fait encore partie des résultats (actualisation automatique).
          const open = this.selected();
          this.items.set(page.items);
          this.selected.set(open ? (page.items.find((i) => i.ts === open.ts && i.body === open.body) ?? null) : null);
          this.nextBefore = page.nextBefore;
          this.stats.set(page);
          this.loading.set(false);
          if (!open) this.viewport()?.scrollToIndex(0);
        },
        error: (e) => {
          this.loading.set(false);
          this.error.set(e?.status === 400 ? 'Requête invalide.' : 'Erreur lors de la recherche.');
        },
      }),
      this.api.logHistogram(r, q, level, service).subscribe({ next: (h) => this.histogram.set(h), error: () => {} }),
    ];
  }

  onScroll(index: number) {
    if (this.live() || this.loadingMore || !this.nextBefore) return;
    if (index + 60 < this.items().length) return;
    this.loadingMore = true;
    this.api.logs(this.state.range(), this.appliedQuery(), this.level(), this.state.service(), this.nextBefore).subscribe({
      next: (page) => {
        this.items.update((list) => [...list, ...page.items]);
        this.nextBefore = page.nextBefore;
        this.loadingMore = false;
      },
      error: () => (this.loadingMore = false),
    });
  }

  toggleLive() {
    this.live.update((v) => !v);
    if (this.live()) this.startLive();
    else {
      this.stopLive();
      this.load();
    }
  }

  private startLive() {
    this.stopLive();
    this.items.set([]);
    this.selected.set(null);
    const params = new URLSearchParams();
    if (this.appliedQuery()) params.set('q', this.appliedQuery());
    if (this.level()) params.set('level', this.level());
    if (this.state.service()) params.set('service', this.state.service());
    if (this.state.env()) params.set('env', this.state.env());
    this.source = new EventSource('/api/logs/tail?' + params.toString(), { withCredentials: true });
    this.source.onmessage = (ev) => {
      const batch = JSON.parse(ev.data) as LogItem[];
      batch.reverse();
      this.items.update((list) => [...batch, ...list].slice(0, MAX_LIVE));
    };
    this.source.onerror = () => this.error.set(this.source?.readyState === EventSource.CLOSED ? 'Flux interrompu.' : '');
  }

  private stopLive() {
    this.source?.close();
    this.source = null;
  }

  ngOnDestroy() {
    this.stopLive();
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.subs.forEach((s) => s.unsubscribe());
  }
}
