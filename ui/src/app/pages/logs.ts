import { Component, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { Subscription } from 'rxjs';
import { Api, Histogram, LogItem } from '../core/api';
import { AppState } from '../core/state';
import { LEVEL_COLORS, LEVELS, NumPipe, TimePipe, parseJson } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';
import { Attributes, LevelBadge } from '../shared/widgets';

const LEVEL_FILTERS = [
  { value: '', label: 'Tout' },
  { value: 'info', label: '≥ Info' },
  { value: 'warn', label: '≥ Warn' },
  { value: 'error', label: '≥ Error' },
];

const MAX_LIVE = 5000;

@Component({
  selector: 'vg-logs',
  imports: [FormsModule, ScrollingModule, Chart, LevelBadge, Attributes, NumPipe, TimePipe, RouterLink],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <form class="searchbar" (ngSubmit)="search()">
          <input class="search" name="q" [(ngModel)]="query" placeholder='timeout service:api level:warn http.route:/users/* "texte exact" -exclure' />
          <button class="btn" type="submit">Rechercher</button>
        </form>
        <div class="seg">
          @for (l of levelFilters; track l.value) {
            <button [class.on]="level() === l.value" (click)="setLevel(l.value)">{{ l.label }}</button>
          }
        </div>
        <button class="btn" [class.on]="live()" (click)="toggleLive()">{{ live() ? 'Arrêter le direct' : 'Suivre en direct' }}</button>
      </div>

      @if (!live()) {
        <div class="panel chart-panel">
          <vg-chart [times]="histTimes()" [series]="histSeries()" kind="bars" [stacked]="true" [height]="96" [legend]="false" (rangeSelect)="zoom($event)" />
        </div>
      }

      <div class="split" [class.with-detail]="selected()">
        <section class="panel results">
          <div class="panel-head small">
            @if (live()) {
              <span><span class="live-dot"></span>{{ items().length | num }} logs reçus depuis l'ouverture du flux</span>
            } @else {
              <span>{{ total() | num }} logs</span>
              @if (stats(); as s) {
                <span class="muted">{{ s.elapsedMs }} ms, {{ s.scannedSegments }} segment(s) lu(s) sur {{ s.totalSegments }}</span>
              }
            }
            <span class="spacer"></span>
            @if (error()) { <span class="danger">{{ error() }}</span> }
          </div>
          <cdk-virtual-scroll-viewport itemSize="26" class="viewport" (scrolledIndexChange)="onScroll($event)">
            <div *cdkVirtualFor="let log of items(); trackBy: trackLog" class="row" [class.sel]="log === selected()" (click)="select(log)">
              <span class="ts mono">{{ log.ts | time: true }}</span>
              <vg-level [level]="log.level" />
              <span class="svc ellipsis">{{ log.service }}</span>
              <span class="msg mono ellipsis">@if (log.isCrash) { <span class="tag crash">crash</span> }{{ log.body }}</span>
            </div>
          </cdk-virtual-scroll-viewport>
          @if (!items().length && !loading()) {
            <div class="empty">{{ live() ? 'En attente de nouveaux logs.' : 'Aucun log ne correspond à la recherche.' }}</div>
          }
        </section>

        @if (selected(); as log) {
          <aside class="panel detail">
            <div class="panel-head">
              <vg-level [level]="log.level" />
              <span class="mono small">{{ log.ts | time: true }}</span>
              <span class="small muted">{{ log.service }}</span>
              <span class="spacer"></span>
              <button class="btn ghost" (click)="selected.set(null)">Fermer</button>
            </div>
            <div class="detail-body">
              <pre class="body">{{ log.body }}</pre>

              <div class="links small">
                <a (click)="addFilter('service', log.service)">Filtrer sur ce service</a>
                @if (log.traceId) {
                  <a [routerLink]="['/traces', log.traceId]" [queryParams]="{ around: log.ts }">Ouvrir la trace</a>
                  <a (click)="addFilter('trace', log.traceId)">Logs de la même trace</a>
                }
                @if (log.fingerprint) {
                  <a [routerLink]="['/errors', log.fingerprint]">Voir le regroupement d'erreurs</a>
                }
              </div>

              @if (log.exceptionType) {
                <h3>Exception</h3>
                <div class="mono small"><strong>{{ log.exceptionType }}</strong>: {{ log.exceptionMessage }}</div>
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

              <h3>Attributs</h3>
              <vg-attributes [json]="log.attributes" [exclude]="['vigil.breadcrumbs']" />

              <h3>Contexte</h3>
              <table class="ctx">
                <tr><td>Version</td><td>{{ log.version ?? '–' }}</td></tr>
                <tr><td>Hôte</td><td>{{ log.host ?? '–' }}</td></tr>
                <tr><td>Environnement</td><td>{{ log.env ?? '–' }}</td></tr>
                <tr><td>Catégorie</td><td class="mono">{{ log.category ?? '–' }}</td></tr>
                <tr><td>Trace</td><td class="mono">{{ log.traceId ?? '–' }}</td></tr>
                <tr><td>Span</td><td class="mono">{{ log.spanId ?? '–' }}</td></tr>
              </table>

              <h3>Ressource</h3>
              <vg-attributes [json]="log.resource" />
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .searchbar { display: flex; gap: 6px; flex: 1; min-width: 320px; }
    .chart-panel { padding: 6px 10px 2px; }
    .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin-right: 8px; animation: blink 1.4s infinite; }
    @keyframes blink { 50% { opacity: .3; } }
    .split { display: grid; grid-template-columns: 1fr; gap: 14px; }
    .split.with-detail { grid-template-columns: minmax(0, 1fr) minmax(380px, 40%); }
    .results { display: flex; flex-direction: column; overflow: hidden; }
    .results .panel-head { gap: 14px; }
    .viewport { height: calc(100vh - 290px); min-height: 300px; }
    .row { height: 26px; display: grid; grid-template-columns: 148px 30px 120px minmax(0, 1fr); align-items: center; gap: 12px;
      padding: 0 12px; border-bottom: 1px solid var(--border-soft); cursor: default; font-size: 12.5px; }
    .row:hover { background: var(--row-hover); }
    .row.sel { background: var(--row-selected); }
    .ts { color: var(--text-3); font-size: 12px; }
    .svc { color: var(--text-2); }
    .msg .tag { margin-right: 6px; }
    .detail { display: flex; flex-direction: column; max-height: calc(100vh - 120px); position: sticky; top: 60px; overflow: hidden; }
    .detail-body { overflow: auto; padding: 12px; min-height: 0; }
    .detail-body > * + * { margin-top: 10px; }
    .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 var(--mono); }
    .links { display: flex; flex-wrap: wrap; gap: 4px 14px; }
    .links a { cursor: pointer; }
    h3 { margin-top: 6px; }
    .crumbs { font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; max-height: 220px; overflow: auto; }
    .ctx { font-size: 12px; border-collapse: collapse; width: 100%; table-layout: fixed; }
    .ctx td { overflow-wrap: anywhere; }
    .ctx td:first-child { width: 110px; }
    .ctx td { padding: 2px 16px 2px 0; vertical-align: top; }
    .ctx td:first-child { color: var(--text-3); white-space: nowrap; }
    @media (max-width: 1200px) {
      .split.with-detail { grid-template-columns: 1fr; }
      .detail { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100%); max-height: none; z-index: 60; border-radius: 0;
        box-shadow: -12px 0 32px rgba(0, 0, 0, .35); }
    }
  `,
})
export class LogsPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);

  /** Paramètres d'URL (liens partageables). */
  readonly q = input<string>('');
  readonly level = signal('');
  readonly levelParam = input<string>('', { alias: 'level' });

  protected readonly levelFilters = LEVEL_FILTERS;
  protected query = '';
  private readonly appliedQuery = signal('');
  protected readonly items = signal<LogItem[]>([]);
  protected readonly selected = signal<LogItem | null>(null);
  protected readonly histogram = signal<Histogram | null>(null);
  protected readonly stats = signal<{ elapsedMs: number; scannedSegments: number; totalSegments: number } | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly live = signal(false);
  private nextBefore: string | null = null;
  private loadingMore = false;
  private subs: Subscription[] = [];
  private source: EventSource | null = null;
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

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
        this.appliedQuery.set(this.query);
        if (level) this.level.set(level);
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.appliedQuery();
      this.level();
      untracked(() => (this.live() ? this.startLive() : this.load()));
    });
  }

  protected trackLog = (_: number, l: LogItem) => l.ts + l.body.length + l.service;

  search() {
    this.appliedQuery.set(this.query.trim());
    this.router.navigate([], { queryParams: { q: this.query.trim() || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  setLevel(level: string) {
    this.level.set(level);
  }

  addFilter(key: string, value: string) {
    const token = /\s/.test(value) ? `${key}:"${value}"` : `${key}:${value}`;
    if (!this.query.includes(token)) this.query = (this.query + ' ' + token).trim();
    this.search();
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
    this.selected.set(null);
    this.nextBefore = null;
    const r = this.state.range();
    const q = this.appliedQuery();
    const level = this.level();
    const service = this.state.service();
    this.subs = [
      this.api.logs(r, q, level, service).subscribe({
        next: (page) => {
          this.items.set(page.items);
          this.nextBefore = page.nextBefore;
          this.stats.set(page);
          this.loading.set(false);
          this.viewport()?.scrollToIndex(0);
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
    this.subs.forEach((s) => s.unsubscribe());
  }
}
