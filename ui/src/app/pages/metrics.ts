import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { Api, MetricData, MetricInfo } from '../core/api';
import { AppState } from '../core/state';

import { Chart, ChartSeries, paletteColor } from '../shared/chart';

const TYPES = ['', 'jauge', 'compteur', 'histogramme', 'histogramme exp.', 'résumé'];

@Component({
  selector: 'vg-metrics',
  imports: [FormsModule, Chart],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head"><h1>Métriques</h1></div>
      <div class="layout">
        <div class="panel list-card">
          <input class="filter" [(ngModel)]="filter" placeholder="Filtrer les métriques…" />
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
  protected readonly metrics = signal<MetricInfo[]>([]);
  protected readonly selected = signal<string>(localStorage.getItem('vigil.metric') ?? '');
  protected readonly groupBy = signal('service');
  protected readonly stat = signal('p95');
  protected readonly keys = signal<string[]>([]);
  protected readonly data = signal<MetricData | null>(null);
  protected readonly loading = signal(false);
  protected filter = '';
  private sub?: Subscription;

  protected readonly filtered = computed(() => this.metrics().filter((m) => !this.filter || m.name.includes(this.filter)));
  protected readonly selectedInfo = computed(() => this.metrics().find((m) => m.name === this.selected()) ?? null);
  protected readonly series = computed<ChartSeries[]>(() =>
    (this.data()?.series ?? []).map((s, i) => ({ label: s.group, color: paletteColor(i), values: s.values })),
  );

  constructor() {
    effect(() => {
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
    this.sub = this.api.metricSeries(this.state.range(), name, this.state.service(), this.groupBy(), this.stat()).subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  type(t: number) { return TYPES[t] ?? ''; }

  statLabel(s: string) {
    return ({ rate: 'taux par seconde', last: 'valeur cumulée', sum: 'somme', avg: 'moyenne', max: 'maximum', count: 'nombre par seconde' } as Record<string, string>)[s] ?? s;
  }
}

function pickDefault(m: MetricInfo[]): string {
  return (m.find((x) => x.name === 'http.server.request.duration') ?? m[0]).name;
}
