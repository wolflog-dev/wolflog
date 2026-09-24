import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable, Subscription, map } from 'rxjs';
import { Api, ErrorGroup, LogItem, MetricData, Panel } from '../core/api';
import { AppState } from '../core/state';
import { AgoPipe, LEVEL_COLORS, LEVELS, NumPipe, TimePipe, formatDuration, formatNumber } from '../core/format';
import { Chart, ChartSeries, paletteColor } from './chart';
import { LevelBadge } from './widgets';

export const PANEL_HEIGHTS: Record<string, number> = { s: 120, m: 220, l: 360 };

type Data =
  | { kind: 'series'; times: string[]; series: ChartSeries[]; unit: string | null; bars: boolean; stacked: boolean }
  | { kind: 'logs'; items: LogItem[] }
  | { kind: 'errors'; items: ErrorGroup[] }
  | { kind: 'stat'; value: string; hint: string };

/** Un panneau de tableau de bord : charge ses données selon son type, suit la période et les filtres globaux. */
@Component({
  selector: 'vg-dashboard-panel',
  imports: [Chart, LevelBadge, NumPipe, TimePipe, AgoPipe, RouterLink],
  template: `
    <div class="body" [style.min-height.px]="height()">
      @if (error()) {
        <div class="empty small danger">{{ error() }}</div>
      } @else {
        @switch (data()?.kind) {
          @case ('series') {
            @let d = asSeries();
            @if (d.series.length) {
              <vg-chart [times]="d.times" [series]="d.series" [kind]="d.bars ? 'bars' : 'lines'" [stacked]="d.stacked"
                        [height]="height()" [unit]="d.unit" [legend]="panel().height !== 's'"
                        (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
            } @else {
              <div class="empty small">Aucune donnée sur la période.</div>
            }
          }
          @case ('stat') {
            @let d = asStat();
            <div class="stat"><strong>{{ d.value }}</strong><span>{{ d.hint }}</span></div>
          }
          @case ('logs') {
            <div class="rows" [style.max-height.px]="height()">
              @for (l of asLogs(); track $index) {
                <div class="row small"><span class="mono muted">{{ l.ts | time }}</span><vg-level [level]="l.level" /><span class="mono ellipsis">{{ l.body }}</span></div>
              } @empty {
                <div class="empty small">Aucun log.</div>
              }
            </div>
          }
          @case ('errors') {
            <div class="rows" [style.max-height.px]="height()">
              @for (e of asErrors(); track e.fingerprint) {
                <a class="row small err" [routerLink]="['/errors', e.fingerprint]">
                  <span class="mono ellipsis">@if (e.crashes) { <span class="tag crash">crash</span> } {{ e.exceptionType }}</span>
                  <span class="ellipsis muted">{{ e.message }}</span>
                  <span class="r">{{ e.count | num }}</span>
                  <span class="muted nowrap">{{ e.lastSeen | ago }}</span>
                </a>
              } @empty {
                <div class="empty small">Aucune erreur.</div>
              }
            </div>
          }
          @default {
            <div class="empty small">Chargement…</div>
          }
        }
      }
    </div>
  `,
  styles: `
    .body { position: relative; }
    .stat { display: grid; align-content: center; height: 100%; min-height: inherit; padding: 4px 4px; gap: 4px; }
    .stat strong { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .stat span { font-size: 11.5px; color: var(--text-3); }
    .rows { overflow: auto; }
    .row { display: grid; grid-template-columns: 90px 30px minmax(0, 1fr); gap: 10px; align-items: center; padding: 3px 2px;
      border-bottom: 1px solid var(--border-soft); color: inherit; }
    .row.err { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 60px 90px; }
    .row.err:hover { background: var(--row-hover); text-decoration: none; }
    .r { text-align: right; font-variant-numeric: tabular-nums; }
    .tag { margin-right: 4px; }
    .empty { padding: 20px 8px; }
  `,
})
export class DashboardPanel implements OnDestroy {
  protected readonly state = inject(AppState);
  private readonly api = inject(Api);
  readonly panel = input.required<Panel>();

  protected readonly data = signal<Data | null>(null);
  protected readonly error = signal('');
  protected readonly height = computed(() => PANEL_HEIGHTS[this.panel().height] ?? PANEL_HEIGHTS['m']);
  private sub?: Subscription;

  protected readonly asSeries = computed(() => this.data() as Extract<Data, { kind: 'series' }>);
  protected readonly asStat = computed(() => this.data() as Extract<Data, { kind: 'stat' }>);
  protected readonly asLogs = computed(() => (this.data() as Extract<Data, { kind: 'logs' }>).items);
  protected readonly asErrors = computed(() => (this.data() as Extract<Data, { kind: 'errors' }>).items.slice(0, 10));

  constructor() {
    effect(() => {
      this.panel();
      this.state.range();
      this.state.service();
      this.state.tick();
      untracked(() => this.load());
    });
  }

  private load() {
    this.sub?.unsubscribe();
    this.error.set('');
    const p = this.panel();
    const r = this.state.range();
    const service = p.service || this.state.service();
    let source: Observable<Data>;

    switch (p.type) {
      case 'http':
        source = this.api
          .requestSeries(r, { service, q: p.query, status: p.statusClass, direction: p.outgoing ? 'out' : 'in' }, p.stat || 'rate', p.groupBy || 'route')
          .pipe(map((d) => series(d, false)));
        break;
      case 'metric':
        if (!p.metric) {
          this.error.set('Aucune métrique choisie : modifiez le panneau.');
          return;
        }
        source = this.api.metricSeries(r, p.metric, service, p.groupBy || 'service', p.stat || '').pipe(map((d) => series(d, false)));
        break;
      case 'logs':
        source = this.api.logHistogram(r, p.query ?? '', p.level ?? '', service).pipe(
          map((h) => ({
            kind: 'series' as const,
            times: h.buckets.map((b) => b.t),
            series: LEVELS.map((l) => ({ label: l, color: LEVEL_COLORS[l], values: h.buckets.map((b) => b[l]) })),
            unit: null,
            bars: true,
            stacked: true,
          })),
        );
        break;
      case 'logs-table':
        source = this.api.logs(r, p.query ?? '', p.level ?? '', service, null, 50).pipe(map((page) => ({ kind: 'logs' as const, items: page.items })));
        break;
      case 'errors':
        source = this.api.errors(r, p.query ?? '', service).pipe(map((items) => ({ kind: 'errors' as const, items })));
        break;
      default:
        source = this.statSource(p, r, service);
    }

    this.sub = source.subscribe({
      next: (d) => this.data.set(d),
      error: () => this.error.set('Impossible de charger ce panneau.'),
    });
  }

  private statSource(p: Panel, r: { from: string; to: string }, service: string): Observable<Data> {
    if (p.source === 'logs') {
      return this.api.logHistogram(r, p.query ?? '', p.level ?? '', service).pipe(
        map((h) => {
          const total = h.buckets.reduce((s, b) => s + b.trace + b.debug + b.info + b.warn + b.error + b.fatal, 0);
          return { kind: 'stat' as const, value: formatNumber(total), hint: `logs${p.level ? ' ≥ ' + p.level : ''}${p.query ? ' « ' + p.query + ' »' : ''}` };
        }),
      );
    }
    if (p.source === 'errors') {
      return this.api.errors(r, p.query ?? '', service).pipe(
        map((g) => ({ kind: 'stat' as const, value: formatNumber(g.reduce((s, x) => s + x.count, 0)), hint: `exceptions, ${g.length} groupe(s)` })),
      );
    }
    return this.api.requestSummary(r, { service, q: p.query, status: p.statusClass, direction: p.outgoing ? 'out' : 'in' }).pipe(
      map((s) => {
        switch (p.stat) {
          case 'count': return { kind: 'stat' as const, value: formatNumber(s.count), hint: 'requêtes' };
          case 'errorRate': return { kind: 'stat' as const, value: `${s.errorRate.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`, hint: `${formatNumber(s.errors)} en erreur` };
          case 'p50': return { kind: 'stat' as const, value: formatDuration(s.p50Ms), hint: 'latence médiane' };
          case 'p95': return { kind: 'stat' as const, value: formatDuration(s.p95Ms), hint: 'latence p95' };
          case 'p99': return { kind: 'stat' as const, value: formatDuration(s.p99Ms), hint: 'latence p99' };
          default: return { kind: 'stat' as const, value: formatNumber(s.ratePerSecond), hint: 'requêtes par seconde' };
        }
      }),
    );
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }
}

function series(d: MetricData, bars: boolean): Data {
  return {
    kind: 'series',
    times: d.times,
    series: d.series.map((s, i) => ({ label: s.group, color: paletteColor(i), values: s.values })),
    unit: d.unit,
    bars,
    stacked: false,
  };
}
