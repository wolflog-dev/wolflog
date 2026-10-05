import { Component, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsBreakdownRow, AnalyticsDimension, AnalyticsSummary } from '../core/models';
import { dimensionValue } from '../core/audience-labels';
import { NumPipe } from '../core/pipes/num-pipe';
import { NavIcon } from './nav-icon';
import { Skeleton } from './skeleton';

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
  imports: [NumPipe, NavIcon, Skeleton],
  template: `
    <section class="panel">
      <div class="panel-head">
        <div class="seg">
          @for (t of tabs(); track t.dimension) {
            <button [class.on]="t === tab()" (click)="select(t)">{{ t.label }}</button>
          }
        </div>
        <span class="spacer"></span>
        @if (loading() && rows().length) { <wl-nav-icon class="spin" name="refresh" [size]="13" title="Actualisation" /> }
        @if (rows().length >= 10 || expanded()) {
          <button class="btn ghost small more" [class.open]="expanded()" (click)="expanded.set(!expanded())">
            {{ expanded() ? 'Réduire' : 'Tout voir' }}<wl-nav-icon name="chevron" [size]="13" />
          </button>
        }
      </div>
      <div class="head-row">
        <span class="h-label">{{ tab().column }}</span>
        @if (users()) { <span class="h-users" title="Utilisateurs connectés distincts"><wl-nav-icon name="users" [size]="12" /></span> }
        <span class="h-value">{{ tab().value }}</span>
      </div>
      <div class="rows" [class.expanded]="expanded()" [class.stale]="loading() && rows().length">
        @if (loading() && !rows().length) {
          <wl-skeleton [rows]="6" />
        } @else {
          @for (r of rows(); track r.value; let i = $index) {
            <button class="row" [style.--w]="share(r)" [style.--i]="i" (click)="clicked(r)" [title]="rowTitle(r)">
              <span class="bar"></span>
              <span class="label ellipsis" [class.muted]="r.value === null">
                @if (tab().dimension === 'country' && r.value) { <span class="code">{{ r.value }}</span> }
                {{ label(r) }}
              </span>
              <wl-nav-icon class="act" [name]="tab().dimension === 'event' ? 'eye' : 'filter'" [size]="12" />
              @if (users()) { <span class="users num" [class.none-yet]="!r.users">{{ r.users | num }}</span> }
              <span class="val num">{{ metric(r) | num }}</span>
              <span class="pct num">{{ percent(r) }}</span>
            </button>
          } @empty {
            <div class="none"><wl-nav-icon name="inbox" [size]="18" /><span>Aucune donnée sur cette période</span></div>
          }
        }
      </div>
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    section { display: flex; flex-direction: column; height: 100%; }
    .head-row { display: flex; align-items: center; gap: 10px; padding: 8px 14px 4px; font: 600 10.5px var(--sans); color: var(--text-3);
      text-transform: uppercase; letter-spacing: .06em; }
    .h-label { flex: 1; min-width: 0; }
    /* Colonnes de largeur fixe : l'en-tête « utilisateurs » reste aligné sur ses valeurs. */
    .h-users, .users { flex: none; width: 38px; text-align: right; }
    .h-users { display: inline-flex; justify-content: flex-end; }
    .h-value { flex: none; width: 100px; text-align: right; }
    .rows { padding: 0 6px 8px; min-height: 180px; transition: opacity .3s; }
    .rows.stale { opacity: .6; }
    .rows.expanded { max-height: 460px; overflow: auto; }
    .rows wl-skeleton { padding: 8px 8px; }
    .row { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; height: 30px; padding: 0 8px; border: 0; background: none;
      color: var(--text-1); font: 12.5px var(--sans); text-align: left; cursor: pointer; border-radius: 8px;
      animation: row-in .35s var(--ease) backwards; animation-delay: calc(min(var(--i), 14) * 18ms); }
    /* Part de la valeur : barre qui se remplit (transform), plus vive au survol. */
    .bar { position: absolute; inset: 2px 0; border-radius: 7px; transform-origin: left; transform: scaleX(var(--w));
      background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 22%, transparent), var(--accent-soft));
      transition: transform .6s var(--ease), opacity .2s; animation: grow .7s var(--ease) backwards; animation-delay: calc(min(var(--i), 14) * 25ms); }
    @keyframes grow { from { transform: scaleX(0); } }
    .row::after { content: ''; position: absolute; inset: 2px 0; border-radius: 7px; background: var(--row-hover); opacity: 0; transition: opacity .15s; }
    .row:hover::after { opacity: 1; }
    .row:hover .bar { opacity: .8; }
    .label, .val, .pct, .act, .users { position: relative; z-index: 1; }
    .label { flex: 1; min-width: 0; }
    .code { font: 600 10px var(--mono); color: var(--text-3); margin-right: 4px; }
    /* Action du clic (filtrer, voir les propriétés) : apparaît en glissant au survol. */
    .act { color: var(--accent); opacity: 0; transform: translateX(-6px); transition: opacity .2s, transform .3s var(--spring); }
    .row:hover .act, .row:focus-visible .act { opacity: 1; transform: none; }
    .val { min-width: 48px; text-align: right; font-weight: 600; }
    .users { font-size: 12px; color: var(--text-2); }
    .users.none-yet { color: var(--text-3); }
    .pct { width: 42px; text-align: right; color: var(--text-3); font-size: 11.5px; }
    @keyframes row-in { from { opacity: 0; transform: translateY(3px); } }
    .none { display: grid; justify-items: center; gap: 6px; padding: 44px 16px; color: var(--text-3); font-size: 12.5px; animation: row-in .4s var(--ease) backwards; }
    .none wl-nav-icon { color: var(--accent); opacity: .7; }
    .more { gap: 4px; }
    .more wl-nav-icon { transition: transform .4s var(--spring); }
    .more.open wl-nav-icon { transform: rotate(180deg); }
    .spin { color: var(--text-3); animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
})
export class AudienceBreakdown implements OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);

  readonly tabs = input.required<BreakdownTab[]>();
  readonly filters = input.required<Record<string, string>>();
  readonly summary = input<AnalyticsSummary | null>(null);
  /** Colonne des utilisateurs connectés : seulement si l'application les identifie. */
  protected readonly users = computed(() => (this.summary()?.users ?? 0) > 0);
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

  /** Infobulle : valeur complète (souvent tronquée), puis l'action du clic. */
  protected rowTitle(r: AnalyticsBreakdownRow) {
    return `${this.label(r)}\n${this.tab().dimension === 'event' ? 'Voir les propriétés' : 'Filtrer sur cette valeur'}`;
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
