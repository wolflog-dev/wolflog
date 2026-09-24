import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api, HttpQuery, HttpRequestItem, HttpSummary, MetricData } from '../core/api';
import { AppState } from '../core/state';
import { DurPipe, NumPipe, TimePipe } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';

const STATUS_COLORS: Record<string, string> = { '2': '#5a6780', '3': '#7aa2f7', '4': '#c9973f', '5': '#d45f5f' };

@Component({
  selector: 'vg-requests',
  imports: [FormsModule, Chart, DurPipe, NumPipe, TimePipe],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <form class="page-head" (ngSubmit)="apply()">
        <h1>Requêtes HTTP</h1>
        <div class="seg">
          <button type="button" [class.on]="direction() === 'in'" (click)="direction.set('in')">Reçues</button>
          <button type="button" [class.on]="direction() === 'out'" (click)="direction.set('out')">Sortantes</button>
        </div>
        <span class="spacer"></span>
        <div class="seg">
          @for (s of statuses; track s.value) {
            <button type="button" [class.on]="status() === s.value" (click)="status.set(s.value)">{{ s.label }}</button>
          }
        </div>
        <input name="q" [(ngModel)]="text" [placeholder]="direction() === 'in' ? 'Route ou chemin, ex. /api/orders' : 'Hôte ou URL'" class="q" />
        <input name="min" [(ngModel)]="minMs" type="number" min="0" placeholder="Durée min. (ms)" class="min" />
        <button class="btn" type="submit">Filtrer</button>
      </form>

      @if (summary(); as s) {
        <div class="panel facts">
          <div><span>Requêtes</span><strong>{{ s.count | num }}</strong></div>
          <div><span>Débit</span><strong>{{ s.ratePerSecond | num }} /s</strong></div>
          <div><span>Erreurs</span><strong [class.danger]="s.errors > 0">{{ s.errors | num }}</strong><em>{{ s.errorRate | num }} %</em></div>
          <div><span>p50</span><strong>{{ s.p50Ms | dur }}</strong></div>
          <div><span>p95</span><strong>{{ s.p95Ms | dur }}</strong></div>
          <div><span>p99</span><strong>{{ s.p99Ms | dur }}</strong></div>
        </div>
      }

      @if (series(); as d) {
        <div class="panel chart-panel">
          <vg-chart [times]="d.times" [series]="chartSeries()" kind="bars" [stacked]="true" [height]="110" unit="req/s" (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
        </div>
      }

      <section class="panel">
        @if (items().length) {
          <table class="list">
            <thead>
              <tr><th>Date</th><th>Méthode</th><th>{{ direction() === 'in' ? 'Route' : 'Hôte' }}</th><th>Chemin</th><th>Service</th><th class="r">Statut</th><th class="r">Durée</th><th></th></tr>
            </thead>
            <tbody>
              @for (r of items(); track r.spanId) {
                <tr class="click" (click)="open(r)">
                  <td class="mono small muted nowrap">{{ r.ts | time: true }}</td>
                  <td class="mono">{{ r.method }}</td>
                  <td class="mono ellipsis route">{{ r.route ?? '–' }}</td>
                  <td class="mono ellipsis target muted">{{ r.target }}</td>
                  <td class="nowrap">{{ r.service }}</td>
                  <td class="r mono" [class.danger]="r.error" [class.warn]="!r.error && (r.status ?? 0) >= 400">{{ r.status ?? '–' }}</td>
                  <td class="r mono nowrap">{{ r.durationMs | dur }}</td>
                  <td class="small muted nowrap">{{ r.hasBody ? 'corps' : '' }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loading()) {
          <div class="empty">Aucune requête sur cette période.</div>
        }
      </section>
    </div>
  `,
  styles: `
    .q { width: 240px; }
    .min { width: 120px; }
    .facts { display: flex; flex-wrap: wrap; }
    .facts > div { display: grid; gap: 2px; padding: 8px 16px; border-right: 1px solid var(--border); min-width: 110px; }
    .facts > div:last-child { border-right: 0; }
    .facts span, .facts em { font-size: 11.5px; color: var(--text-3); font-style: normal; }
    .facts strong { font-weight: 600; font-size: 15px; }
    .chart-panel { padding: 6px 10px 2px; }
    .route { max-width: 0; width: 26%; }
    .target { max-width: 0; width: 30%; }
    .warn { color: var(--warn); }
  `,
})
export class RequestsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);

  protected readonly statuses = [
    { value: '', label: 'Tous' },
    { value: '2xx', label: '2xx' },
    { value: '4xx', label: '4xx' },
    { value: '5xx', label: '5xx' },
    { value: 'errors', label: 'En erreur' },
  ];
  protected readonly direction = signal<'in' | 'out'>('in');
  protected readonly status = signal('');
  protected text = '';
  protected minMs: number | null = null;
  private readonly applied = signal({ text: '', minMs: null as number | null });

  protected readonly items = signal<HttpRequestItem[]>([]);
  protected readonly summary = signal<HttpSummary | null>(null);
  protected readonly series = signal<MetricData | null>(null);
  protected readonly loading = signal(false);
  private subs: Subscription[] = [];

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
      this.state.range();
      this.state.tick();
      this.state.service();
      this.direction();
      this.status();
      this.applied();
      untracked(() => this.load());
    });
  }

  apply() {
    this.applied.set({ text: this.text, minMs: this.minMs });
  }

  private load() {
    this.subs.forEach((s) => s.unsubscribe());
    this.loading.set(true);
    const r = this.state.range();
    const f: HttpQuery = {
      service: this.state.service(),
      q: this.applied().text,
      minMs: this.applied().minMs,
      status: this.status(),
      direction: this.direction(),
    };
    this.subs = [
      this.api.requests(r, f).subscribe({
        next: (items) => {
          this.items.set(items);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      }),
      this.api.requestSummary(r, f).subscribe((s) => this.summary.set(s)),
      this.api.requestSeries(r, f, 'rate', 'status').subscribe((s) => this.series.set(s)),
    ];
  }

  open(r: HttpRequestItem) {
    this.router.navigate(['/traces', r.traceId], { queryParams: { around: r.ts, span: r.spanId } });
  }
}
