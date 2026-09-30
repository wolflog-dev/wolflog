import { Component, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsBreakdownRow, AnalyticsDimension, AnalyticsSummary } from '../core/models';
import { dimensionValue } from '../core/audience-labels';
import { NumPipe } from '../core/pipes/num-pipe';

/** Onglet d'un panneau de ventilation : dimension, en-têtes et total de référence pour les pourcentages. */
export interface BreakdownTab {
  dimension: AnalyticsDimension;
  label: string;
  column: string;
  value: string;
  /** Total utilisé pour les pourcentages (visiteurs par défaut). */
  total?: 'pageviews' | 'visits' | 'events';
  /** Dimension filtrée au clic (ex. entrée → page). */
  filter?: AnalyticsDimension;
}

/** Top des valeurs d'une ou plusieurs dimensions ; un clic sur une ligne filtre toute la page. */
@Component({
  selector: 'wl-audience-breakdown',
  imports: [NumPipe],
  template: `
    <section class="panel">
      <div class="panel-head">
        <div class="tabs">
          @for (t of tabs(); track t.dimension) {
            <button [class.on]="t === tab()" (click)="select(t)">{{ t.label }}</button>
          }
        </div>
        <span class="spacer"></span>
        @if (rows().length >= 10 || expanded()) {
          <button class="btn ghost small" (click)="expanded.set(!expanded())">{{ expanded() ? 'Réduire' : 'Tout voir' }}</button>
        }
      </div>
      <div class="head-row"><span>{{ tab().column }}</span><span>{{ tab().value }}</span></div>
      <div class="rows" [class.expanded]="expanded()">
        @for (r of rows(); track r.value; let i = $index) {
          <button class="row" [style.--w]="share(r)" [style.--i]="i" (click)="clicked(r)"
                  [title]="tab().dimension === 'event' ? 'Voir les propriétés' : 'Filtrer sur cette valeur'">
            <span class="bar"></span>
            <span class="label ellipsis" [class.muted]="r.value === null">
              @if (tab().dimension === 'country' && r.value) { <span class="code">{{ r.value }}</span> }
              {{ label(r) }}
            </span>
            <span class="val num">{{ metric(r) | num }}</span>
            <span class="pct num">{{ percent(r) }}</span>
          </button>
        } @empty {
          <div class="empty small">{{ loading() ? 'Chargement…' : 'Aucune donnée' }}</div>
        }
      </div>
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    section { display: flex; flex-direction: column; height: 100%; }
    .tabs { display: flex; gap: 2px; flex-wrap: wrap; }
    .tabs button { height: 24px; padding: 0 8px; border: 0; border-radius: var(--radius); background: none; color: var(--text-3); font: 500 12px var(--sans); cursor: pointer; }
    .tabs button:hover { color: var(--text-1); }
    .tabs button.on { background: var(--surface-3); color: var(--text-1); }
    .head-row { display: flex; justify-content: space-between; padding: 8px 12px 4px; font: 500 11px var(--sans); color: var(--text-3); }
    .rows { padding: 0 6px 8px; min-height: 180px; }
    .rows.expanded { max-height: 460px; overflow: auto; }
    .row { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; height: 28px; padding: 0 6px; border: 0; background: none;
      color: var(--text-1); font: 12.5px var(--sans); text-align: left; cursor: pointer; border-radius: 3px;
      animation: row-in .35s ease-out both; animation-delay: calc(var(--i) * 18ms); }
    .row:hover .bar { background: var(--accent-soft); filter: brightness(1.6); }
    .bar { position: absolute; inset: 2px auto 2px 0; width: calc(var(--w) * 100%); background: var(--accent-soft); border-radius: 3px;
      transition: width .5s ease-out; }
    .label, .val, .pct { position: relative; }
    .label { flex: 1; min-width: 0; }
    .code { font: 600 10px var(--mono); color: var(--text-3); margin-right: 4px; }
    .val { font-weight: 600; }
    .pct { width: 42px; text-align: right; color: var(--text-3); font-size: 11.5px; }
    @keyframes row-in { from { opacity: 0; transform: translateY(3px); } }
    @media (prefers-reduced-motion: reduce) { .row { animation: none; } .bar { transition: none; } }
  `,
})
export class AudienceBreakdown implements OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);

  readonly tabs = input.required<BreakdownTab[]>();
  readonly filters = input.required<Record<string, string>>();
  readonly summary = input<AnalyticsSummary | null>(null);
  /** Filtre demandé (dimension, valeur). */
  readonly pick = output<{ dimension: AnalyticsDimension; value: string | null }>();
  /** Événement cliqué : afficher ses propriétés. */
  readonly eventPick = output<string>();

  protected readonly selected = signal<BreakdownTab | null>(null);
  protected readonly tab = computed(() => this.selected() ?? this.tabs()[0]);
  protected readonly expanded = signal(false);
  protected readonly rows = signal<AnalyticsBreakdownRow[]>([]);
  protected readonly loading = signal(false);
  private sub?: Subscription;

  constructor() {
    effect(() => {
      const tab = this.tab();
      const filters = this.filters();
      const limit = this.expanded() ? 200 : 10;
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      untracked(() => this.load(tab, filters, limit));
    });
  }

  protected select(t: BreakdownTab) {
    this.selected.set(t);
    this.expanded.set(false);
  }

  private load(tab: BreakdownTab, filters: Record<string, string>, limit: number) {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.sub = this.api.analyticsBreakdown(this.state.range(), this.state.service(), filters, tab.dimension, limit).subscribe({
      next: (rows) => { this.rows.set(rows); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  protected metric(r: AnalyticsBreakdownRow) {
    return this.tab().total ? r.count : r.visitors;
  }

  private totalFor(): number {
    const s = this.summary();
    const t = this.tab().total;
    if (!s) return 0;
    return t === 'pageviews' ? s.pageviews : t === 'visits' ? s.visits : t === 'events' ? s.events : s.visitors;
  }

  protected share(r: AnalyticsBreakdownRow) {
    const total = this.totalFor() || Math.max(1, ...this.rows().map((x) => this.metric(x)));
    return Math.min(1, this.metric(r) / total).toFixed(4);
  }

  protected percent(r: AnalyticsBreakdownRow) {
    const total = this.totalFor();
    if (!total) return '';
    const p = (this.metric(r) / total) * 100;
    return p > 0 && p < 1 ? '<1 %' : `${Math.round(p)} %`;
  }

  protected label(r: AnalyticsBreakdownRow) {
    return dimensionValue(this.tab().dimension, r.value);
  }

  protected clicked(r: AnalyticsBreakdownRow) {
    const tab = this.tab();
    if (tab.dimension === 'event' && r.value) this.eventPick.emit(r.value);
    else this.pick.emit({ dimension: tab.filter ?? tab.dimension, value: r.value });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }
}
