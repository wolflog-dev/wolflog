import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsComparison, AnalyticsDimension, AnalyticsEventProperty, AnalyticsSeries } from '../core/models';
import { DIMENSION_NAMES, dimensionValue } from '../core/audience-labels';
import { formatDuration, formatNumber } from '../core/format';
import { NumPipe } from '../core/pipes/num-pipe';
import { Chart, ChartSeries } from '../shared/chart';
import { AudienceBreakdown, BreakdownTab } from '../shared/audience-breakdown';
import { AudienceFunnel } from '../shared/audience-funnel';
import { AudienceLive } from '../shared/audience-live';
import { CodeBlock } from '../shared/code-block';

interface Kpi {
  label: string;
  value: string;
  change: number | null;
  /** true : une baisse est une bonne nouvelle (taux de rebond). */
  invert?: boolean;
}

/** Audience web anonyme : visiteurs, pages, sources, événements, temps réel et entonnoirs (script RUM ou Wolflog.Client.Blazor). */
@Component({
  selector: 'wl-audience',
  imports: [RouterLink, Chart, NumPipe, AudienceBreakdown, AudienceLive, AudienceFunnel, CodeBlock],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Audience</h1>
        <span class="spacer"></span>
        @if (tab() === 'overview') {
          <label class="check"><input type="checkbox" [checked]="compare()" (change)="compare.set(!compare())" /> Comparer</label>
        }
        <div class="seg">
          <button [class.on]="tab() === 'overview'" (click)="tab.set('overview')">Vue d'ensemble</button>
          <button [class.on]="tab() === 'live'" (click)="tab.set('live')">Temps réel</button>
          <button [class.on]="tab() === 'funnel'" (click)="tab.set('funnel')">Entonnoir</button>
        </div>
      </div>

      @if (filterList().length) {
        <div class="chips">
          @for (f of filterList(); track f.key) {
            <span class="chip"><span class="muted">{{ f.name }}</span> <strong>{{ f.label }}</strong>
              <button (click)="removeFilter(f.key)" title="Retirer le filtre" aria-label="Retirer le filtre">✕</button></span>
          }
          <button class="btn ghost small" (click)="filters.set({})">Tout effacer</button>
        </div>
      }

      @switch (tab()) {
        @case ('live') { <wl-audience-live /> }
        @case ('funnel') { <wl-audience-funnel [filters]="filters()" /> }
        @default {
          @if (empty()) {
            <section class="panel setup">
              <div class="panel-body">
                <h2>Aucune visite sur cette période</h2>
                <p>Mesure anonyme, sans cookie : le script navigateur ou, pour Blazor Server, <strong>Wolflog.Client.Blazor</strong>.
                  Créez une clé « navigateur » dans <a routerLink="/admin/keys">Clés API</a>, puis ajoutez :</p>
                <wl-code [code]="snippet" />
                <p class="muted small">Événements : <code>wolflog.track('inscription', {{ '{' }} plan: 'pro' {{ '}' }})</code> ou
                  <code>data-wolflog-event="inscription"</code>. Une propriété <code>revenue</code> alimente le chiffre d'affaires.</p>
              </div>
            </section>
          }

          <section class="panel overview">
            <div class="kpis">
              @for (k of kpis(); track k.label; let i = $index) {
                <div class="kpi" [style.--i]="i">
                  <span>{{ k.label }}</span>
                  <strong class="num">{{ k.value }}</strong>
                  @if (k.change !== null) {
                    <em class="num" [class.good]="k.invert ? k.change < 0 : k.change > 0" [class.bad]="k.invert ? k.change > 0 : k.change < 0">
                      {{ k.change > 0 ? '+' : '' }}{{ k.change }} %
                    </em>
                  }
                </div>
              }
            </div>
            @if (series(); as s) {
              <div class="chart">
                <div class="keys">
                  @for (c of chartSeries(); track c.label) {
                    <span><i [style.background]="c.color" [class.dashed]="!!c.dash"></i>{{ c.label }}</span>
                  }
                </div>
                <wl-chart [times]="s.times" [series]="chartSeries()" kind="lines" [height]="200" [legend]="false" [deployments]="false"
                          (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
              </div>
            }
          </section>

          <div class="grid">
            @for (p of panels; track $index) {
              <wl-audience-breakdown [tabs]="p" [filters]="filters()" [summary]="summary()?.current ?? null"
                (pick)="addFilter($event.dimension, $event.value)" (eventPick)="showEvent($event)" />
            }
          </div>

          @if (eventName(); as name) {
            <section class="panel props">
              <div class="panel-head">
                <h2>{{ name }}</h2>
                <span class="spacer"></span>
                <button class="btn ghost" (click)="addFilter('event', name)">Filtrer</button>
                <button class="btn ghost" (click)="eventName.set(null)" aria-label="Fermer">✕</button>
              </div>
              <div class="panel-body prop-grid">
                @for (g of propertyGroups(); track g.key) {
                  <div>
                    <h3>{{ g.key }}</h3>
                    @for (v of g.values; track v.value) {
                      <div class="line"><span class="ellipsis">{{ v.value ?? '(vide)' }}</span><span class="num">{{ v.count | num }}</span></div>
                    }
                  </div>
                } @empty {
                  <p class="muted small">Aucune propriété envoyée avec cet événement sur la période.</p>
                }
              </div>
            </section>
          }
        }
      }
    </div>
  `,
  styles: `
    h1 { font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 4px 0 10px; border: 1px solid var(--border);
      border-radius: 13px; background: var(--surface-2); font-size: 12px; animation: chip-in .25s ease-out; }
    .chip button { width: 18px; height: 18px; border: 0; border-radius: 50%; background: var(--surface-3); color: var(--text-2); cursor: pointer; font-size: 10px; }
    .chip button:hover { background: var(--danger); color: var(--bg); }
    .overview { border-radius: 8px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 4px 24px; padding: 18px 20px 6px; }
    .kpi { display: grid; gap: 2px; animation: kpi-in .4s ease-out both; animation-delay: calc(var(--i) * 40ms); }
    .kpi span { font-size: 12px; color: var(--text-3); }
    .kpi strong { font-weight: 600; font-size: 24px; letter-spacing: -.02em; line-height: 1.2; }
    .kpi em { font-style: normal; font-size: 11.5px; color: var(--text-3); }
    .kpi em.good { color: var(--ok); }
    .kpi em.bad { color: var(--danger); }
    .chart { padding: 8px 12px 4px; }
    .keys { display: flex; gap: 16px; padding: 0 8px 4px; justify-content: flex-end; font-size: 11.5px; color: var(--text-3); }
    .keys span { display: inline-flex; align-items: center; gap: 6px; }
    .keys i { width: 10px; height: 3px; border-radius: 2px; }
    .keys i.dashed { opacity: .5; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; }
    .setup h2 { margin: 0 0 8px; font-size: 14px; }
    .setup p { margin: 0 0 10px; }
    .setup wl-code { display: block; margin-bottom: 10px; }
    .prop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .prop-grid h3 { margin-bottom: 6px; }
    .line { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; border-bottom: 1px solid var(--border-soft); font-size: 12.5px; }
    @keyframes chip-in { from { opacity: 0; transform: scale(.95); } }
    @keyframes kpi-in { from { opacity: 0; transform: translateY(4px); } }
    @media (prefers-reduced-motion: reduce) { .kpi { animation: none; } }
  `,
})
export class AudiencePage implements OnDestroy {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);

  protected readonly tab = signal<'overview' | 'live' | 'funnel'>('overview');
  protected readonly compare = signal(false);
  protected readonly filters = signal<Record<string, string>>({});
  protected readonly summary = signal<AnalyticsComparison | null>(null);
  protected readonly series = signal<AnalyticsSeries | null>(null);
  protected readonly loading = signal(false);
  protected readonly eventName = signal<string | null>(null);
  protected readonly properties = signal<AnalyticsEventProperty[]>([]);
  private subs: Subscription[] = [];

  protected readonly snippet =
    `<script src="${location.origin}/wolflog-rum.js" defer\n        data-key="wlb_…" data-service="mon-site" data-env="prod"></script>`;

  protected readonly panels: BreakdownTab[][] = [
    [
      { dimension: 'page', label: 'Pages', column: 'Page', value: 'Vues', total: 'pageviews' },
      { dimension: 'entry', label: 'Entrées', column: "Page d'entrée", value: 'Visites', total: 'visits', filter: 'page' },
      { dimension: 'exit', label: 'Sorties', column: 'Page de sortie', value: 'Visites', total: 'visits', filter: 'page' },
      { dimension: 'title', label: 'Titres', column: 'Titre', value: 'Vues', total: 'pageviews' },
    ],
    [
      { dimension: 'referrer', label: 'Référents', column: 'Source', value: 'Visiteurs' },
      { dimension: 'utm_source', label: 'Source', column: 'utm_source', value: 'Visiteurs' },
      { dimension: 'utm_medium', label: 'Support', column: 'utm_medium', value: 'Visiteurs' },
      { dimension: 'utm_campaign', label: 'Campagne', column: 'utm_campaign', value: 'Visiteurs' },
    ],
    [
      { dimension: 'browser', label: 'Navigateurs', column: 'Navigateur', value: 'Visiteurs' },
      { dimension: 'os', label: 'Systèmes', column: 'Système', value: 'Visiteurs' },
      { dimension: 'device', label: 'Appareils', column: 'Appareil', value: 'Visiteurs' },
      { dimension: 'screen', label: 'Écrans', column: 'Résolution', value: 'Visiteurs' },
    ],
    [
      { dimension: 'country', label: 'Pays', column: 'Pays', value: 'Visiteurs' },
      { dimension: 'language', label: 'Langues', column: 'Langue', value: 'Visiteurs' },
      { dimension: 'host', label: 'Domaines', column: 'Domaine', value: 'Vues', total: 'pageviews' },
    ],
    [
      { dimension: 'event', label: 'Événements', column: 'Événement', value: 'Occurrences', total: 'events' },
      { dimension: 'source', label: 'Collecte', column: 'Origine', value: 'Visiteurs' },
    ],
  ];

  protected readonly empty = computed(() => {
    const s = this.summary();
    return !!s && !s.current.pageviews && !s.previous.pageviews && !Object.keys(this.filters()).length;
  });

  protected readonly kpis = computed<Kpi[]>(() => {
    const s = this.summary();
    if (!s) return [];
    const c = s.current, p = s.previous;
    const change = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    const list: Kpi[] = [
      { label: 'Visiteurs', value: formatNumber(c.visitors), change: change(c.visitors, p.visitors) },
      { label: 'Visites', value: formatNumber(c.visits), change: change(c.visits, p.visits) },
      { label: 'Pages vues', value: formatNumber(c.pageviews), change: change(c.pageviews, p.pageviews) },
      { label: 'Taux de rebond', value: `${Math.round(c.bounceRate)} %`, change: change(c.bounceRate, p.bounceRate), invert: true },
      { label: 'Durée moyenne', value: formatDuration(c.avgVisitSeconds * 1000), change: change(c.avgVisitSeconds, p.avgVisitSeconds) },
      { label: 'Événements', value: formatNumber(c.events), change: change(c.events, p.events) },
    ];
    if (c.revenue || p.revenue) {
      list.push({ label: "Chiffre d'affaires", value: c.revenue.toLocaleString('fr-FR', { maximumFractionDigits: 0 }), change: change(c.revenue, p.revenue) });
    }
    return list;
  });

  protected readonly chartSeries = computed<ChartSeries[]>(() => {
    const s = this.series();
    if (!s) return [];
    const list: ChartSeries[] = [
      { label: 'Visiteurs', color: '#7aa2f7', values: s.visitors },
      { label: 'Pages vues', color: '#e0af68', values: s.pageviews },
    ];
    if (s.previousVisitors) list.push({ label: 'Période précédente', color: '#7aa2f7', values: s.previousVisitors, dash: [5, 4] });
    return list;
  });

  protected readonly filterList = computed(() =>
    Object.entries(this.filters()).map(([key, value]) => ({
      key, name: DIMENSION_NAMES[key as AnalyticsDimension] ?? key, label: dimensionValue(key, value || null),
    })),
  );

  protected readonly propertyGroups = computed(() => {
    const groups = new Map<string, AnalyticsEventProperty[]>();
    for (const p of this.properties()) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
    return [...groups.entries()].map(([key, values]) => ({ key, values: values.slice(0, 15) }));
  });

  constructor() {
    effect(() => {
      this.filters();
      this.compare();
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      untracked(() => this.load());
    });
  }

  private load() {
    this.subs.forEach((s) => s.unsubscribe());
    const r = this.state.range(), service = this.state.service(), f = this.filters();
    this.loading.set(true);
    this.subs = [
      this.api.analyticsSummary(r, service, f).subscribe({ next: (s) => { this.summary.set(s); this.loading.set(false); }, error: () => this.loading.set(false) }),
      this.api.analyticsSeries(r, service, f, this.compare()).subscribe((s) => this.series.set(s)),
    ];
    const name = this.eventName();
    if (name) this.showEvent(name);
  }

  protected addFilter(dimension: AnalyticsDimension, value: string | null) {
    this.filters.update((f) => ({ ...f, [dimension]: value ?? '' }));
    this.tab.set('overview');
  }

  protected removeFilter(key: string) {
    this.filters.update((f) => {
      const next = { ...f };
      delete next[key];
      return next;
    });
  }

  protected showEvent(name: string) {
    this.eventName.set(name);
    this.api.analyticsEventProperties(this.state.range(), this.state.service(), this.filters(), name).subscribe((p) => this.properties.set(p));
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
  }
}
