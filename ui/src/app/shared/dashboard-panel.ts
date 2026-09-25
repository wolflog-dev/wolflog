import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Observable, Subscription, map } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { Api, CustomRow, ErrorGroup, LogItem, MetricData, Panel } from '../core/api';
import { AppState } from '../core/state';
import { AgoPipe, LEVEL_COLORS, LEVELS, NumPipe, TimePipe, formatDuration, formatNumber } from '../core/format';
import { Chart, ChartSeries, paletteColor } from './chart';
import { LevelBadge } from './widgets';

export const PANEL_HEIGHTS: Record<string, number> = { s: 120, m: 220, l: 380 };

export const AGGREGATES: { value: string; label: string; numeric: boolean }[] = [
  { value: 'count', label: 'Nombre', numeric: false },
  { value: 'rate', label: 'Nombre par seconde', numeric: false },
  { value: 'distinct', label: 'Valeurs distinctes de…', numeric: false },
  { value: 'avg', label: 'Moyenne de…', numeric: true },
  { value: 'sum', label: 'Somme de…', numeric: true },
  { value: 'min', label: 'Minimum de…', numeric: true },
  { value: 'max', label: 'Maximum de…', numeric: true },
  { value: 'p50', label: 'Médiane (p50) de…', numeric: true },
  { value: 'p75', label: 'p75 de…', numeric: true },
  { value: 'p90', label: 'p90 de…', numeric: true },
  { value: 'p95', label: 'p95 de…', numeric: true },
  { value: 'p99', label: 'p99 de…', numeric: true },
];

const STATUS_CLASS_COLORS: Record<string, string> = { '1': '#6f747e', '2': '#5a6780', '3': '#7aa2f7', '4': '#c9973f', '5': '#d45f5f' };

/**
 * Couleur porteuse de sens quand les groupes en ont un (niveaux de log, codes HTTP, statut),
 * sinon couleur de palette.
 */
export function seriesColor(group: string, index: number): string {
  const g = group.toLowerCase();
  if (LEVEL_COLORS[g]) return LEVEL_COLORS[g];
  if (/^[1-5]\d\d$/.test(g)) return STATUS_CLASS_COLORS[g[0]];
  if (g === 'erreur') return '#d45f5f';
  if (g === 'ok') return '#7fb685';
  return paletteColor(index);
}

/** Les niveaux de log sont empilés dans leur ordre naturel. */
function orderSeries<T extends { group: string }>(series: T[]): T[] {
  if (!series.every((s) => (LEVELS as readonly string[]).includes(s.group))) return series;
  return [...series].sort((a, b) => LEVELS.indexOf(a.group as never) - LEVELS.indexOf(b.group as never));
}

/** Libellé lisible d'un calcul : "Nombre", "p95 de duration"… */
export function describeAggregate(agg: string | null | undefined, field: string | null | undefined): string {
  const a = AGGREGATES.find((x) => x.value === (agg ?? 'count'));
  if (!a) return agg ?? '';
  return a.label.endsWith('…') ? a.label.replace('…', ' ' + (field ?? '?')) : a.label;
}

export function formatValue(v: number | null | undefined, unit: string | null | undefined): string {
  if (v === null || v === undefined) return '–';
  if (unit === 'ms') return formatDuration(v);
  if (unit === '/s') return formatNumber(v) + ' /s';
  return formatNumber(v) + (unit ? ' ' + unit : '');
}

/** Lien vers la page qui montre les données d'un panneau. */
export function panelDataLink(p: Panel): { path: string; query: Record<string, string> } {
  if (p.type === 'custom') {
    if (p.dataSource === 'spans') return { path: '/traces', query: {} };
    if (p.dataSource === 'metrics') return { path: '/metrics', query: {} };
    return { path: '/logs', query: p.query ? { q: p.query } : {} };
  }
  if (p.type === 'http' || (p.type === 'stat' && (p.source ?? 'http') === 'http')) return { path: '/requests', query: {} };
  if (p.type === 'metric') return { path: '/metrics', query: {} };
  if (p.type === 'errors' || p.source === 'errors') return { path: '/errors', query: {} };
  const q: Record<string, string> = {};
  if (p.query) q['q'] = p.query;
  if (p.level) q['level'] = p.level;
  return { path: '/logs', query: q };
}

/** Paramètres de « Nouvelle alerte » pré-remplis à partir d'un panneau. */
export function panelAlertLink(p: Panel): Record<string, string> {
  const q: Record<string, string> = { edit: 'new', name: p.title };
  if (p.service) q['service'] = p.service;
  if (p.type === 'custom') {
    Object.assign(q, { kind: 'query', source: p.dataSource ?? 'logs', agg: p.aggregate ?? 'count' });
    if (p.query) q['filter'] = p.query;
    if (p.field) q['field'] = p.field;
    if (p.groupBy && p.groupBy !== 'level') q['groupBy'] = p.groupBy;
    return q;
  }
  if (p.type === 'http' || (p.type === 'stat' && (p.source ?? 'http') === 'http')) {
    Object.assign(q, { kind: 'http', stat: ['p50', 'p95', 'p99', 'rate'].includes(p.stat ?? '') ? p.stat! : 'errorRate' });
    if (p.query) q['route'] = p.query;
    return q;
  }
  if (p.type === 'errors' || p.source === 'errors') return { ...q, kind: 'error' };
  return { ...q, kind: 'query', source: 'logs', agg: 'count', filter: [p.query, p.level ? 'level:' + p.level : ''].filter(Boolean).join(' ') };
}

type Data =
  | { kind: 'series'; times: string[]; series: ChartSeries[]; unit: string | null; bars: boolean; stacked: boolean }
  | { kind: 'rank' | 'table'; rows: CustomRow[]; unit: string | null; label: string }
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
              <div class="empty small">Aucune donnée sur cette période.</div>
            }
          }
          @case ('rank') {
            @let d = asRows();
            <div class="rank" [style.max-height.px]="height()">
              @for (r of d.rows; track r.group; let i = $index) {
                <div class="rank-row" [class.link]="drillable()" (click)="drill(r.group)" [title]="r.group + ' : ' + fmt(r.value, d.unit)">
                  <span class="label ellipsis">{{ r.group }}</span>
                  <span class="track"><span class="bar" [style.width.%]="share(r.value, d.rows)" [style.background]="color(r.group, i)"></span></span>
                  <span class="value">{{ fmt(r.value, d.unit) }}</span>
                </div>
              } @empty {
                <div class="empty small">Aucune donnée sur cette période.</div>
              }
            </div>
          }
          @case ('table') {
            @let d = asRows();
            <div class="table-wrap" [style.max-height.px]="height()">
              @if (d.rows.length) {
                <table class="list">
                  <thead><tr><th>Valeur</th><th class="r">{{ d.label }}</th><th class="r">Part</th></tr></thead>
                  <tbody>
                    @for (r of d.rows; track r.group) {
                      <tr [class.click]="drillable()" (click)="drill(r.group)">
                        <td class="mono ellipsis cell">{{ r.group }}</td>
                        <td class="r nowrap">{{ fmt(r.value, d.unit) }}</td>
                        <td class="r muted nowrap">{{ percent(r.value, d.rows) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <div class="empty small">Aucune donnée sur cette période.</div>
              }
            </div>
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
    .stat { display: grid; align-content: center; min-height: inherit; padding: 4px; gap: 4px; }
    .stat strong { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .stat span { font-size: 11.5px; color: var(--text-3); }
    .rows, .rank, .table-wrap { overflow: auto; }
    .row { display: grid; grid-template-columns: 90px 30px minmax(0, 1fr); gap: 10px; align-items: center; padding: 3px 2px;
      border-bottom: 1px solid var(--border-soft); color: inherit; }
    .row.err { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 60px 90px; }
    .row.err:hover { background: var(--row-hover); text-decoration: none; }
    .rank-row { display: grid; grid-template-columns: minmax(80px, 38%) minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 4px 2px; font-size: 12.5px; }
    .rank-row.link { cursor: pointer; }
    .rank-row.link:hover { background: var(--row-hover); }
    .label { font-family: var(--mono); font-size: 12px; }
    .track { height: 8px; background: var(--surface-3); border-radius: 2px; overflow: hidden; }
    .bar { display: block; height: 100%; min-width: 2px; opacity: .85; }
    .value { font-variant-numeric: tabular-nums; min-width: 60px; text-align: right; }
    .cell { max-width: 0; width: 60%; }
    .r { text-align: right; font-variant-numeric: tabular-nums; }
    table.list td { padding: 4px 8px; }
    table.list th { padding: 5px 8px; }
    .tag { margin-right: 4px; }
    .empty { padding: 20px 8px; }
  `,
})
export class DashboardPanel implements OnDestroy {
  protected readonly state = inject(AppState);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly panel = input.required<Panel>();
  /** Hauteur forcée (aperçu dans l'éditeur, panneau agrandi). */
  readonly heightOverride = input<number | null>(null);

  protected readonly data = signal<Data | null>(null);
  protected readonly error = signal('');
  protected readonly height = computed(() => this.heightOverride() ?? PANEL_HEIGHTS[this.panel().height] ?? PANEL_HEIGHTS['m']);
  protected readonly drillable = computed(() => {
    const p = this.panel();
    return p.type === 'custom' && (p.dataSource ?? 'logs') === 'logs' && !!p.groupBy;
  });
  private sub?: Subscription;

  protected readonly asSeries = computed(() => this.data() as Extract<Data, { kind: 'series' }>);
  protected readonly asRows = computed(() => this.data() as Extract<Data, { kind: 'rank' | 'table' }>);
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

  protected fmt = formatValue;
  protected color = seriesColor;

  protected share(v: number | null, rows: CustomRow[]) {
    const max = Math.max(...rows.map((r) => r.value ?? 0), 0);
    return max > 0 ? ((v ?? 0) / max) * 100 : 0;
  }

  protected percent(v: number | null, rows: CustomRow[]) {
    const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
    return total > 0 ? `${(((v ?? 0) / total) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : '–';
  }

  /** Ouvre les logs correspondant à une valeur du regroupement. */
  protected drill(group: string) {
    if (!this.drillable()) return;
    const p = this.panel();
    const value = /\s/.test(group) ? `"${group}"` : group;
    const q = [p.query, group === '(vide)' ? '' : `${p.groupBy}:${value}`].filter(Boolean).join(' ');
    this.router.navigate(['/logs'], { queryParams: { q } });
  }

  private load() {
    this.sub?.unsubscribe();
    this.error.set('');
    const p = this.panel();
    const r = this.state.range();
    const service = p.service || this.state.service();
    let source: Observable<Data>;

    switch (p.type) {
      case 'custom': {
        const view = p.view ?? 'timeseries';
        source = this.api
          .customQuery(r, {
            source: p.dataSource ?? 'logs', filter: p.query, agg: p.aggregate ?? 'count', field: p.field,
            groupBy: p.groupBy, view, limit: p.limit ?? 10, service,
          })
          .pipe(
            map((res): Data => {
              if (view === 'stat') return { kind: 'stat', value: formatValue(res.value, res.unit), hint: `${describeAggregate(p.aggregate, p.field)} · ${formatNumber(res.count)} élément(s)` };
              if (view === 'top' || view === 'table') return { kind: view === 'top' ? 'rank' : 'table', rows: res.rows ?? [], unit: res.unit, label: describeAggregate(p.aggregate, p.field) };
              return {
                kind: 'series',
                times: res.times ?? [],
                series: orderSeries(res.series ?? []).map((s, i) => ({ label: s.group, color: seriesColor(s.group, i), values: s.values })),
                unit: res.unit,
                bars: view === 'bars',
                stacked: view === 'bars',
              };
            }),
          );
        break;
      }
      case 'http':
        source = this.api
          .requestSeries(r, { service, q: p.query, status: p.statusClass, direction: p.outgoing ? 'out' : 'in' }, p.stat || 'rate', p.groupBy || 'route')
          .pipe(map((d) => series(d)));
        break;
      case 'metric':
        if (!p.metric) {
          this.error.set('Aucune métrique choisie : configurez le panneau.');
          return;
        }
        source = this.api.metricSeries(r, p.metric, service, p.groupBy || 'service', p.stat || '').pipe(map((d) => series(d)));
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
        source = this.api.errors(r, p.query ?? '', service, 'todo').pipe(map((l) => ({ kind: 'errors' as const, items: l.items })));
        break;
      default:
        source = this.statSource(p, r, service);
    }

    this.sub = source.subscribe({
      next: (d) => this.data.set(d),
      error: (e: unknown) => {
        const message = e instanceof HttpErrorResponse && typeof e.error?.error === 'string' ? e.error.error : 'Impossible de charger ce panneau.';
        this.error.set(message);
      },
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
      return this.api.errors(r, p.query ?? '', service, 'todo', 1000).pipe(
        map((l) => ({ kind: 'stat' as const, value: formatNumber(l.items.reduce((s, x) => s + x.count, 0)), hint: `exceptions, ${l.counts.todo} à traiter` })),
      );
    }
    return this.api.requestSummary(r, { service, q: p.query, status: p.statusClass, direction: p.outgoing ? 'out' : 'in' }).pipe(
      map((s) => {
        switch (p.stat) {
          case 'count': return { kind: 'stat' as const, value: formatNumber(s.count), hint: 'requêtes' };
          case 'errorRate': return { kind: 'stat' as const, value: `${s.errorRate.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`, hint: `${formatNumber(s.errors)} en erreur (5xx)` };
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

function series(d: MetricData): Data {
  return {
    kind: 'series',
    times: d.times,
    series: d.series.map((s, i) => ({ label: s.group, color: seriesColor(s.group, i), values: s.values })),
    unit: d.unit,
    bars: false,
    stacked: false,
  };
}
