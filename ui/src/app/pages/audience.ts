import { Component, ElementRef, OnDestroy, afterRenderEffect, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsComparison, AnalyticsDimension, AnalyticsEventProperty, AnalyticsSeries } from '../core/models';
import { DIMENSION_NAMES, dimensionValue } from '../core/audience-labels';
import { formatDuration, formatNumber } from '../core/format';
import { NumPipe } from '../core/pipes/num-pipe';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { Chart, ChartSeries } from '../shared/chart';
import { AudienceBreakdown, BreakdownTab } from '../shared/audience-breakdown';
import { AudienceFunnel } from '../shared/audience-funnel';
import { AudienceLive } from '../shared/audience-live';
import { CodeBlock } from '../shared/code-block';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';

interface Kpi {
  label: string;
  value: string;
  change: number | null;
  /** true : une baisse est une bonne nouvelle (taux de rebond). */
  invert?: boolean;
  icon: string;
  /** Explication (infobulle). */
  hint: string;
}

/** Audience web anonyme : visiteurs, pages, sources, événements, temps réel et entonnoirs (script RUM ou Wolflog.Client.Blazor). */
@Component({
  selector: 'wl-audience',
  imports: [RouterLink, Chart, NumPipe, AudienceBreakdown, AudienceLive, AudienceFunnel, CodeBlock, CountUp, NavIcon, Skeleton],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Audience</h1>
        <span class="spacer"></span>
        @if (tab() === 'overview') {
          <label class="check" title="Superpose la période précédente de même durée" animate.enter="fade-in" animate.leave="fade-out">
            <input type="checkbox" class="switch" [checked]="compare()" (change)="compare.set(!compare())" /> Comparer
          </label>
        }
        <div class="seg">
          <button [class.on]="tab() === 'overview'" (click)="tab.set('overview')"><wl-nav-icon name="chart-line" [size]="13" />Vue d'ensemble</button>
          <button [class.on]="tab() === 'live'" (click)="tab.set('live')"><wl-nav-icon name="bolt" [size]="13" />Temps réel</button>
          <button [class.on]="tab() === 'funnel'" (click)="tab.set('funnel')"><wl-nav-icon name="filter" [size]="13" />Entonnoir</button>
        </div>
      </div>

      @if (filterList().length) {
        <div class="chips">
          @for (f of filterList(); track f.key) {
            <span class="chip" animate.enter="chip-in" animate.leave="chip-out">
              <wl-nav-icon name="filter" [size]="12" />
              <span class="muted">{{ f.name }}</span><strong class="ellipsis" [title]="f.label">{{ f.label }}</strong>
              <button (click)="removeFilter(f.key)" title="Retirer le filtre" aria-label="Retirer le filtre"><wl-nav-icon name="close" [size]="11" /></button>
            </span>
          }
          <button class="btn ghost small clear-all" (click)="filters.set({})"><wl-nav-icon name="close" [size]="13" />Tout effacer</button>
        </div>
      }

      @switch (tab()) {
        @case ('live') { <wl-audience-live /> }
        @case ('funnel') { <wl-audience-funnel [filters]="filters()" /> }
        @default {
          @if (empty()) {
            <section class="panel setup">
              <div class="setup-head">
                <span class="setup-icon"><wl-nav-icon name="audience" [size]="22" /></span>
                <div>
                  <h2>Aucune visite sur cette période</h2>
                  <p class="muted">Mesure anonyme, sans cookie : le script navigateur ou, pour Blazor Server, <strong>Wolflog.Client.Blazor</strong>.</p>
                </div>
              </div>
              <ol class="setup-steps">
                <li>
                  <span class="n">1</span>
                  <div>Créez une clé « navigateur » dans <a routerLink="/admin/keys">Clés API</a>.
                    @if (session.isAdmin()) {
                      <a class="btn small-btn" routerLink="/admin/keys/new"><wl-nav-icon name="keys" [size]="13" />Créer une clé</a>
                    }
                  </div>
                </li>
                <li><span class="n">2</span><div>Ajoutez dans vos pages :<wl-code [code]="snippet" /></div></li>
                <li>
                  <span class="n">3</span>
                  <div class="muted small">Événements : <code>wolflog.track('inscription', {{ '{' }} plan: 'pro' {{ '}' }})</code> ou
                    <code>data-wolflog-event="inscription"</code>. Une propriété <code>revenue</code> alimente le chiffre d'affaires.</div>
                </li>
              </ol>
            </section>
          }

          <section class="panel overview">
            <div class="kpis">
              @for (k of kpis(); track k.label; let i = $index) {
                <div class="kpi" [style.--i]="i" [title]="k.hint">
                  <span class="kpi-label"><wl-nav-icon [name]="k.icon" [size]="13" />{{ k.label }}</span>
                  <strong class="num" [wlCountUp]="k.value"></strong>
                  @if (k.change !== null) {
                    <em class="trend" [class.good]="k.invert ? k.change < 0 : k.change > 0" [class.bad]="k.invert ? k.change > 0 : k.change < 0"
                        title="Par rapport à la période précédente">
                      @if (k.change !== 0) { <wl-nav-icon [name]="k.change > 0 ? 'arrow-up' : 'arrow-down'" [size]="11" /> }
                      {{ k.change > 0 ? '+' : '' }}{{ k.change }} %
                    </em>
                  }
                </div>
              } @empty {
                @for (i of [0, 1, 2, 3, 4, 5]; track i) {
                  <div class="kpi ghost" [style.--i]="i">
                    <i class="skeleton" style="width: 55%; height: 11px"></i>
                    <i class="skeleton" style="width: 75%; height: 24px; margin-top: 4px"></i>
                    <i class="skeleton" style="width: 35%; height: 10px; margin-top: 4px"></i>
                  </div>
                }
              }
            </div>
            @if (series(); as s) {
              <div class="chart">
                <div class="keys">
                  <span class="hint"><wl-nav-icon name="search" [size]="12" />glisser pour zoomer</span>
                  <span class="spacer"></span>
                  @for (c of chartSeries(); track c.label) {
                    <span><i [style.--c]="c.color" [class.dashed]="!!c.dash"></i>{{ c.label }}</span>
                  }
                </div>
                <wl-chart [times]="s.times" [series]="chartSeries()" kind="lines" [height]="200" [legend]="false" [deployments]="false"
                          (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
              </div>
            } @else {
              <div class="chart"><i class="skeleton chart-skeleton"></i></div>
            }
          </section>

          <div class="grid">
            @for (p of panels; track $index) {
              <wl-audience-breakdown [tabs]="p" [filters]="filters()" [summary]="summary()?.current ?? null"
                (pick)="addFilter($event.dimension, $event.value)" (eventPick)="openEvent($event)" />
            }
          </div>

          @if (eventName(); as name) {
            <section class="panel props" #props animate.leave="props-out">
              <div class="panel-head">
                <span class="ev-icon"><wl-nav-icon name="bolt" [size]="14" /></span>
                <h2 class="ellipsis" [title]="name">{{ name }}</h2>
                <span class="muted small nowrap">propriétés envoyées avec l'événement</span>
                <span class="spacer"></span>
                <button class="btn ghost" (click)="addFilter('event', name)"><wl-nav-icon name="filter" [size]="14" />Filtrer</button>
                <button class="btn ghost icon" (click)="eventName.set(null)" title="Fermer" aria-label="Fermer"><wl-nav-icon name="close" [size]="15" /></button>
              </div>
              @if (propsLoading()) {
                <wl-skeleton [rows]="4" />
              } @else {
                <div class="panel-body prop-grid">
                  @for (g of propertyGroups(); track g.key; let gi = $index) {
                    <div class="prop" [style.--g]="gi">
                      <h3><wl-nav-icon name="hash" [size]="11" />{{ g.key }}</h3>
                      @for (v of g.values; track v.value; let j = $index) {
                        <div class="line" [style.--w]="g.max ? v.count / g.max : 0" [style.--j]="j">
                          <i class="bar"></i>
                          <span class="ellipsis" [class.muted]="v.value === null" [title]="v.value ?? '(vide)'">{{ v.value ?? '(vide)' }}</span>
                          <span class="num">{{ v.count | num }}</span>
                        </div>
                      }
                    </div>
                  } @empty {
                    <p class="none muted small"><wl-nav-icon name="inbox" [size]="16" />Aucune propriété envoyée avec cet événement sur la période.</p>
                  }
                </div>
              }
            </section>
          }
        }
      }
    </div>
  `,
  styles: `
    .fade-in { animation: fade-in .3s var(--ease); }
    .fade-out { animation: fade-out .15s ease-in forwards; }
    @keyframes fade-in { from { opacity: 0; transform: translateX(6px); } }
    @keyframes fade-out { to { opacity: 0; transform: translateX(6px); } }
    .seg button { display: inline-flex; align-items: center; gap: 6px; }
    /* Onglet « Temps réel » : pastille verte qui pulse. */

    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip { display: inline-flex; align-items: center; gap: 6px; max-width: 360px; height: 28px; padding: 0 4px 0 10px; border-radius: 999px; font-size: 12px;
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border)); background: var(--accent-soft); box-shadow: inset 0 1px 0 var(--highlight); }
    .chip > wl-nav-icon { color: var(--accent); }
    .chip strong { min-width: 0; font-weight: 600; }
    .chip button { flex: none; display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
      background: var(--surface-3); color: var(--text-2); transition: background-color .2s, color .2s, transform .3s var(--spring); }
    .chip button:hover { background: var(--danger); color: var(--on-accent); transform: rotate(90deg); }
    .chip-in { animation: chip-in .4s var(--spring); }
    .chip-out { animation: chip-out .2s ease-in forwards; }
    @keyframes chip-in { from { opacity: 0; transform: scale(.7); } }
    @keyframes chip-out { to { opacity: 0; transform: scale(.7); } }
    .clear-all { height: 28px; }

    .setup { overflow: hidden; }
    .setup-head { display: flex; align-items: center; gap: 14px; padding: 18px 20px 4px; }
    .setup-head h2 { margin: 0 0 2px; font-size: 15px; }
    .setup-head p { margin: 0; }
    .setup-icon { flex: none; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 14px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 10px 24px -10px var(--accent); }
    .setup-steps { display: grid; gap: 14px; margin: 0; padding: 16px 20px 20px; list-style: none; }
    .setup-steps li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; align-items: start; }
    .setup-steps .n { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; font: 650 11px var(--sans);
      color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
    .setup-steps li > div { min-width: 0; padding-top: 2px; }
    .setup-steps wl-code { margin-top: 8px; }
    .small-btn { height: 26px; margin-left: 8px; font-size: 12px; vertical-align: middle; }

    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 6px 24px; padding: 18px 20px 8px; }
    .kpi { display: grid; gap: 3px; align-content: start; animation: kpi-in .45s var(--ease) backwards; animation-delay: calc(var(--i) * 45ms); }
    .kpi.ghost { gap: 0; }
    .kpi-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); }
    .kpi-label wl-nav-icon { color: var(--accent); transition: transform .4s var(--spring); }
    .kpi:hover .kpi-label wl-nav-icon { transform: scale(1.18) rotate(-8deg); }
    .kpi strong { font-weight: 650; font-size: 25px; letter-spacing: -.02em; line-height: 1.2; }
    .trend { justify-self: start; display: inline-flex; align-items: center; gap: 3px; padding: 0 7px; border-radius: 999px; font-style: normal;
      font: 600 11px/18px var(--sans); font-variant-numeric: tabular-nums; color: var(--text-3); background: var(--surface-2); }
    .trend.good { color: var(--ok); background: color-mix(in srgb, var(--ok) 13%, transparent); }
    .trend.bad { color: var(--danger); background: color-mix(in srgb, var(--danger) 13%, transparent); }
    @keyframes kpi-in { from { opacity: 0; transform: translateY(6px); } }

    .chart { padding: 8px 12px 6px; }
    .keys { display: flex; align-items: center; gap: 16px; padding: 0 8px 6px; font-size: 11.5px; color: var(--text-3); }
    .keys span { display: inline-flex; align-items: center; gap: 6px; }
    .keys .hint { opacity: .75; }
    .keys i { width: 14px; height: 3px; border-radius: 2px; background: var(--c); }
    .keys i.dashed { background: repeating-linear-gradient(90deg, var(--c) 0 4px, transparent 4px 7px); }
    .chart-skeleton { height: 200px; margin: 22px 8px 0; border-radius: var(--radius-sm); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap: 14px; }

    /* Entrée : animation « rise » de la page (enfant direct de .page) ; sortie : glisse et s'efface. */
    .props-out { animation: props-out .2s ease-in forwards; }
    @keyframes props-out { to { opacity: 0; transform: translateY(8px); } }
    .props h2 { min-width: 0; }
    .ev-icon { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--warn);
      background: color-mix(in srgb, var(--warn) 15%, transparent); }
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .prop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; }
    .prop { min-width: 0; animation: kpi-in .4s var(--ease) backwards; animation-delay: calc(var(--g) * 50ms); }
    .prop h3 { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
    .line { position: relative; display: flex; justify-content: space-between; gap: 10px; padding: 4px 6px; border-radius: 6px; font-size: 12.5px; }
    .line > span { position: relative; }
    /* Part de chaque valeur : barre en arrière-plan qui se remplit (transform). */
    .line .bar { position: absolute; inset: 1px 0; border-radius: inherit; background: var(--accent-soft); transform-origin: left;
      transform: scaleX(var(--w)); transition: transform .6s var(--ease); animation: grow .7s var(--ease) backwards; animation-delay: calc(var(--j) * 30ms); }
    @keyframes grow { from { transform: scaleX(0); } }
    .none { display: flex; align-items: center; gap: 8px; margin: 0; }
  `,
})
export class AudiencePage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);

  protected readonly tab = signal<'overview' | 'live' | 'funnel'>('overview');
  protected readonly compare = signal(false);
  protected readonly filters = signal<Record<string, string>>({});
  protected readonly summary = signal<AnalyticsComparison | null>(null);
  protected readonly series = signal<AnalyticsSeries | null>(null);
  protected readonly loading = signal(false);
  protected readonly eventName = signal<string | null>(null);
  protected readonly properties = signal<AnalyticsEventProperty[]>([]);
  protected readonly propsLoading = signal(false);
  private readonly propsPanel = viewChild<ElementRef<HTMLElement>>('props');
  /** Événement ouvert depuis une ventilation : le panneau des propriétés est amené à l'écran. */
  private scrollToProps = false;
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
      { label: 'Visiteurs', value: formatNumber(c.visitors), change: change(c.visitors, p.visitors), icon: 'audience', hint: 'Visiteurs distincts (anonymes)' },
      { label: 'Visites', value: formatNumber(c.visits), change: change(c.visits, p.visits), icon: 'target', hint: 'Sessions de navigation' },
      { label: 'Pages vues', value: formatNumber(c.pageviews), change: change(c.pageviews, p.pageviews), icon: 'page', hint: 'Pages affichées, toutes visites confondues' },
      { label: 'Taux de rebond', value: `${Math.round(c.bounceRate)} %`, change: change(c.bounceRate, p.bounceRate), invert: true, icon: 'logout',
        hint: 'Visites d’une seule page : une baisse est une bonne nouvelle' },
      { label: 'Durée moyenne', value: formatDuration(c.avgVisitSeconds * 1000), change: change(c.avgVisitSeconds, p.avgVisitSeconds), icon: 'timer',
        hint: 'Durée moyenne d’une visite' },
      { label: 'Événements', value: formatNumber(c.events), change: change(c.events, p.events), icon: 'bolt', hint: 'Événements envoyés (wolflog.track, data-wolflog-event)' },
    ];
    if (c.revenue || p.revenue) {
      list.push({ label: "Chiffre d'affaires", value: c.revenue.toLocaleString('fr-FR', { maximumFractionDigits: 0 }), change: change(c.revenue, p.revenue),
        icon: 'sigma', hint: 'Somme des propriétés revenue des événements' });
    }
    return list;
  });

  protected readonly chartSeries = computed<ChartSeries[]>(() => {
    const s = this.series();
    if (!s) return [];
    // Visiteurs : couleur d'accent de la palette choisie (relue à chaque rechargement, donc après un changement de palette).
    const visitors = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7aa2f7';
    const list: ChartSeries[] = [
      { label: 'Visiteurs', color: visitors, values: s.visitors },
      { label: 'Pages vues', color: '#e0af68', values: s.pageviews },
    ];
    if (s.previousVisitors) list.push({ label: 'Période précédente', color: visitors, values: s.previousVisitors, dash: [5, 4] });
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
    return [...groups.entries()].map(([key, values]) => {
      const top = values.slice(0, 15);
      return { key, values: top, max: Math.max(0, ...top.map((v) => v.count)) };
    });
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
    // Panneau des propriétés ouvert depuis une ventilation (souvent plus bas) : défilement doux jusqu'à lui.
    afterRenderEffect(() => {
      this.eventName();
      const el = this.propsPanel()?.nativeElement;
      if (!el || !this.scrollToProps) return;
      this.scrollToProps = false;
      el.scrollIntoView({ behavior: document.documentElement.dataset['motion'] === 'off' ? 'auto' : 'smooth', block: 'nearest' });
    });
  }

  private load() {
    this.subs.forEach((s) => s.unsubscribe());
    const r = this.state.range(), service = this.state.service(), f = this.filters();
    this.loading.set(true);
    this.subs = [
      this.api.analyticsSummary(r, service, f).subscribe({
        next: (s) => { this.summary.set(s); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toasts.error('Impossible de charger l’audience.'); },
      }),
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

  /** Événement cliqué dans une ventilation. */
  protected openEvent(name: string) {
    this.scrollToProps = true;
    this.showEvent(name);
  }

  protected showEvent(name: string) {
    // Squelette seulement pour un nouvel événement : une actualisation garde l'affichage en place.
    if (name !== this.eventName()) {
      this.properties.set([]);
      this.propsLoading.set(true);
    }
    this.eventName.set(name);
    this.api.analyticsEventProperties(this.state.range(), this.state.service(), this.filters(), name).subscribe({
      next: (p) => {
        this.properties.set(p);
        this.propsLoading.set(false);
      },
      error: () => this.propsLoading.set(false),
    });
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
  }
}
