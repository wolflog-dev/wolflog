import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TimePipe, formatDuration, formatNumber, parseJson } from '../core/format';
import { Subscription } from 'rxjs';
import { Api, ExemplarItem, MetricData, MetricInfo, Panel } from '../core/api';
import { AddToDashboard } from '../shared/add-to-dashboard';
import { AppState } from '../core/state';

import { Chart, ChartSeries, paletteColor } from '../shared/chart';

const TYPES = ['', 'jauge', 'compteur', 'histogramme', 'histogramme exp.', 'résumé'];

@Component({
  selector: 'vg-metrics',
  imports: [FormsModule, RouterLink, TimePipe, Chart, AddToDashboard],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head"><h1>Métriques</h1></div>
      <div class="layout">
        <div class="panel list-card">
          <input class="filter" [(ngModel)]="filter" placeholder="Filtrer les métriques…" aria-label="Filtrer les métriques" />
          <div class="names">
            @for (m of filtered(); track m.name) {
              <button class="name" [class.on]="m.name === selected()" (click)="select(m.name)">
                <span class="ellipsis">{{ m.name }}</span>
                <span class="type">{{ type(m.type) }}</span>
              </button>
            } @empty {
              <div class="empty small">Aucune métrique sur la période.</div>
            }
          </div>
        </div>

        <div class="panel chart">
          @if (selectedInfo(); as info) {
            <div class="chart-head">
              <div>
                <h2>{{ info.name }}</h2>
                <div class="muted small">{{ info.description ?? '' }} {{ info.unit ? '(' + info.unit + ')' : '' }}</div>
              </div>
              <div class="spacer"></div>
              @if (info.type === 3 || info.type === 4) {
                <select [ngModel]="stat()" (ngModelChange)="stat.set($event)">
                  <option value="p50">p50</option>
                  <option value="p95">p95</option>
                  <option value="p99">p99</option>
                  <option value="avg">moyenne</option>
                  <option value="max">max</option>
                  <option value="count">nombre / s</option>
                </select>
              }
              <vg-add-to-dashboard [panel]="panelForMetric()" />
              <label class="muted small">Grouper par</label>
              <select [ngModel]="groupBy()" (ngModelChange)="groupBy.set($event)">
                <option value="service">service</option>
                <option value="none">(aucun)</option>
                @for (k of keys(); track k) { <option [value]="k">{{ k }}</option> }
              </select>
            </div>
            @if (data(); as d) {
              <vg-chart [times]="d.times" [series]="series()" kind="lines" [height]="360" [unit]="d.unit" (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
              <div class="muted small foot">Statistique : {{ statLabel(d.stat) }} · pas de {{ d.stepSeconds }} s · {{ d.series.length }} série(s)</div>
            }
            @if (exemplars().length) {
              <div class="exemplars">
                <h3>Traces d'exemple <span class="muted small">mesures reliées à leur trace, les plus élevées d'abord</span></h3>
                <table class="list">
                  <tbody>
                    @for (e of exemplars(); track e.traceId + e.ts) {
                      <tr class="click" [routerLink]="['/traces', e.traceId]" [queryParams]="{ around: e.ts, span: e.spanId }">
                        <td class="mono small nowrap muted">{{ e.ts | time: true }}</td>
                        <td class="r mono nowrap">{{ exemplarValue(e.value, selectedInfo()?.unit) }}</td>
                        <td class="nowrap">{{ e.service }}</td>
                        <td class="muted small ellipsis attrs">{{ describeAttrs(e.attributes) }}</td>
                        <td class="nowrap"><a [routerLink]="['/traces', e.traceId]" [queryParams]="{ around: e.ts, span: e.spanId }" (click)="$event.stopPropagation()">Ouvrir la trace</a></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          } @else {
            <div class="empty">Choisissez une métrique à gauche.</div>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; }
    .list-card { display: flex; flex-direction: column; max-height: calc(100vh - 150px); }
    .filter { margin: 10px; }
    .names { overflow: auto; padding: 0 6px 8px; }
    .name { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 5px 8px; border: 0; border-radius: 3px; background: none;
      color: var(--text-2); font: 12px var(--mono); cursor: pointer; text-align: left; }
    .name:hover { background: var(--surface-3); }
    .name.on { background: var(--accent-soft); color: var(--text-1); }
    .exemplars { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 10px; }
    .exemplars h3 { margin: 0 0 6px; }
    .attrs { max-width: 0; width: 50%; }
    .type { font: 11px var(--sans); color: var(--text-3); white-space: nowrap; }
    .chart { padding: 12px; }
    .chart-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .chart-head h2 { margin: 0; font-family: var(--mono); font-weight: 500; }
    .spacer { flex: 1; }
    .foot { margin-top: 8px; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  `,
})
export class MetricsPage {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);
  /** Paramètre d'URL (recherche globale) : métrique à ouvrir. */
  readonly name = input<string>('');
  protected readonly metrics = signal<MetricInfo[]>([]);
  protected readonly selected = signal<string>(readMetric());
  protected readonly groupBy = signal('service');
  protected readonly stat = signal('p95');
  protected readonly keys = signal<string[]>([]);
  protected readonly data = signal<MetricData | null>(null);
  protected readonly loading = signal(false);
  protected filter = '';
  private sub?: Subscription;

  protected readonly filtered = computed(() => this.metrics().filter((m) => !this.filter || m.name.includes(this.filter)));
  protected readonly selectedInfo = computed(() => this.metrics().find((m) => m.name === this.selected()) ?? null);
  protected readonly panelForMetric = computed<Panel>(() => {
    const info = this.selectedInfo();
    const histogram = info?.type === 3 || info?.type === 4;
    return {
      id: '', type: 'metric', width: 6, height: 'm', metric: this.selected(), groupBy: this.groupBy(),
      stat: histogram ? this.stat() : null, title: info ? `${info.name}${histogram ? ' (' + this.stat() + ')' : ''}` : 'Métrique',
      service: this.state.service() || null,
    };
  });

  protected readonly series = computed<ChartSeries[]>(() =>
    (this.data()?.series ?? []).map((s, i) => ({ label: s.group, color: paletteColor(i), values: s.values })),
  );

  constructor() {
    effect(() => {
      const wanted = this.name();
      if (wanted) untracked(() => this.selected.set(wanted));
    });
    effect(() => {
      this.state.env();
      this.state.range();
      this.state.tick();
      this.state.service();
      untracked(() =>
        this.api.metrics(this.state.range(), this.state.service()).subscribe((m) => {
          this.metrics.set(m);
          if (!m.some((x) => x.name === this.selected()) && m.length) this.select(pickDefault(m));
          else this.loadSeries();
        }),
      );
    });
    effect(() => {
      this.groupBy();
      this.stat();
      untracked(() => this.loadSeries());
    });
  }

  select(name: string) {
    this.selected.set(name);
    try { localStorage.setItem('vigil.metric', name); } catch { /* ignoré */ }
    this.groupBy.set('service');
    this.api.metricKeys(this.state.range(), name).subscribe((k) => this.keys.set(k));
    this.loadSeries();
  }

  private loadSeries() {
    const name = this.selected();
    if (!name) return;
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.api.metricExemplars(this.state.range(), name, this.state.service()).subscribe({
      next: (e) => this.exemplars.set(e),
      error: () => this.exemplars.set([]),
    });
    this.sub = this.api.metricSeries(this.state.range(), name, this.state.service(), this.groupBy(), this.stat()).subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  type(t: number) { return TYPES[t] ?? ''; }

  protected readonly exemplars = signal<ExemplarItem[]>([]);

  /** Valeur dans l'unité de la métrique (secondes converties en durée lisible). */
  protected exemplarValue(v: number, unit: string | null | undefined) {
    if (unit === 's') return formatDuration(v * 1000);
    if (unit === 'ms') return formatDuration(v);
    return formatNumber(v) + (unit && unit !== '1' ? ' ' + unit : '');
  }

  /** Attributs utiles de la mesure (route, code…). */
  protected describeAttrs(json: string) {
    const a = parseJson(json);
    return ['http.route', 'http.request.method', 'http.response.status_code', 'server.address']
      .filter((k) => a[k] !== undefined).map((k) => String(a[k])).join(' ');
  }

  statLabel(s: string) {
    return ({ rate: 'taux par seconde', last: 'valeur cumulée', sum: 'somme', avg: 'moyenne', max: 'maximum', count: 'nombre par seconde' } as Record<string, string>)[s] ?? s;
  }
}

function pickDefault(m: MetricInfo[]): string {
  return (m.find((x) => x.name === 'http.server.request.duration') ?? m[0]).name;
}

function readMetric(): string {
  try { return localStorage.getItem('vigil.metric') ?? ''; } catch { return ''; }
}
