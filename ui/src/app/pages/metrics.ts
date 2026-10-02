import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TimePipe } from '../core/pipes/time-pipe';
import { formatDuration, formatNumber, parseJson } from '../core/format';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { ExemplarItem, MetricData, MetricInfo, Panel } from '../core/models';
import { AddToDashboard } from '../shared/add-to-dashboard';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { Skeleton } from '../shared/skeleton';

import { Chart, ChartSeries, paletteColor } from '../shared/chart';

const TYPES = ['', 'jauge', 'compteur', 'histogramme', 'histogramme exp.', 'résumé'];
/** Icône de chaque type de métrique (même ordre que TYPES). */
const TYPE_ICONS = ['metrics', 'gauge', 'hash', 'chart-bar', 'chart-bar', 'sigma'];

@Component({
  selector: 'wl-metrics',
  imports: [FormsModule, RouterLink, TimePipe, Chart, AddToDashboard, NavIcon, RichOption, Skeleton],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Métriques</h1>
        @if (metrics().length) { <span class="count" title="Métriques reçues sur la période">{{ metrics().length }}</span> }
        <span class="muted small">OpenTelemetry · {{ state.label() }}</span>
      </div>
      <div class="layout">
        <div class="panel list-card">
          <div class="filter-wrap">
            <wl-nav-icon name="search" [size]="14" class="f-icon" />
            <input class="filter" [ngModel]="filter()" (ngModelChange)="filter.set($event)" placeholder="Filtrer les métriques…" aria-label="Filtrer les métriques"
                   (keydown.arrowdown)="focusFirst($event)" (keydown.enter)="pickFirst()" />
            @if (filter()) {
              <button class="clear" type="button" (click)="filter.set('')" title="Effacer le filtre" aria-label="Effacer le filtre"><wl-nav-icon name="close" [size]="12" /></button>
            }
          </div>
          @if (filter() && listLoaded()) { <div class="matches small muted">{{ filtered().length }} sur {{ metrics().length }}</div> }
          <div class="names" #names>
            @if (!listLoaded()) {
              <wl-skeleton [rows]="9" />
            } @else {
              @for (m of filtered(); track m.name; let i = $index) {
                <button class="name" [class.on]="m.name === selected()" [style.--i]="i" (click)="select(m.name)"
                        (keydown.arrowdown)="step($event, 1)" (keydown.arrowup)="step($event, -1)"
                        [title]="m.name + (m.description ? '\\n' + m.description : '') + (m.unit ? '\\nUnité : ' + m.unit : '')">
                  <span class="t-icon"><wl-nav-icon [name]="typeIcon(m.type)" [size]="13" /></span>
                  <span class="ellipsis label">@for (part of parts(m.name); track $index) {<span [class.hit]="part.match">{{ part.text }}</span>}</span>
                  <span class="type">{{ type(m.type) }}</span>
                </button>
              } @empty {
                @if (filter()) {
                  <div class="empty small none">
                    Aucune métrique ne contient « {{ filter() }} ».
                    <button class="btn ghost small" type="button" (click)="filter.set('')"><wl-nav-icon name="close" [size]="12" />Effacer le filtre</button>
                  </div>
                } @else {
                  <div class="empty small none">Aucune métrique sur la période.</div>
                }
              }
            }
          </div>
        </div>

        <div class="panel chart">
          @if (selectedInfo(); as info) {
            <div class="chart-head">
              <span class="m-icon"><wl-nav-icon [name]="typeIcon(info.type)" [size]="18" /></span>
              <div class="m-title">
                <h2 class="ellipsis" [title]="info.name">{{ info.name }}</h2>
                <div class="m-meta small">
                  @if (type(info.type)) { <span class="chip">{{ type(info.type) }}</span> }
                  @if (info.unit) { <span class="chip unit" title="Unité">{{ info.unit }}</span> }
                  @if (info.description) { <span class="muted ellipsis" [title]="info.description">{{ info.description }}</span> }
                </div>
              </div>
              <div class="spacer"></div>
              @if (info.type === 3 || info.type === 4) {
                <select [ngModel]="stat()" (ngModelChange)="stat.set($event)" aria-label="Statistique">
                  <option value="p50" wlOpt="p50" icon="timer" desc="Médiane"></option>
                  <option value="p95" wlOpt="p95" icon="timer" desc="95 % des mesures en dessous"></option>
                  <option value="p99" wlOpt="p99" icon="timer" desc="Les mesures les plus hautes"></option>
                  <option value="avg" wlOpt="moyenne" icon="gauge"></option>
                  <option value="max" wlOpt="max" icon="arrow-up"></option>
                  <option value="count" wlOpt="nombre / s" icon="bolt" desc="Mesures par seconde"></option>
                </select>
              }
              <label class="group-by muted small">Grouper par
                <select [ngModel]="groupBy()" (ngModelChange)="groupBy.set($event)">
                  <option value="service" wlOpt="service" icon="server" desc="Une courbe par service"></option>
                  <option value="none" wlOpt="(aucun)" icon="sigma" desc="Une seule courbe"></option>
                  @for (k of keys(); track k) { <option [value]="k" [wlOpt]="k" icon="split"></option> }
                </select>
              </label>
              <wl-add-to-dashboard [panel]="panelForMetric()" />
            </div>
            @if (data(); as d) {
              @if (d.series.length) {
                <wl-chart [times]="d.times" [series]="series()" kind="lines" [height]="360" [unit]="d.unit" (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
              } @else {
                <div class="empty">Aucun point pour cette métrique sur la période.</div>
              }
              <div class="muted small foot">
                <span><wl-nav-icon name="sigma" [size]="12" />{{ statLabel(d.stat) }}</span>
                <span><wl-nav-icon name="timer" [size]="12" />pas de {{ d.stepSeconds }} s</span>
                <span><wl-nav-icon name="layers" [size]="12" />{{ d.series.length }} série(s)</span>
                <span class="spacer"></span>
                <span><wl-nav-icon name="cursor" [size]="12" />glisser pour zoomer</span>
              </div>
            } @else if (failed()) {
              <div class="empty small danger state">
                Impossible de charger cette métrique.
                <button class="btn ghost small" type="button" (click)="retry()"><wl-nav-icon name="refresh" [size]="13" />Réessayer</button>
              </div>
            } @else {
              <i class="skeleton chart-ghost" aria-busy="true"></i>
            }
            @if (exemplars().length && session.can(['traces', 'requests'])) {
              <div class="exemplars">
                <h3><wl-nav-icon name="traces" [size]="13" />Traces d'exemple <span class="muted small">mesures reliées à leur trace, les plus élevées d'abord</span></h3>
                <table class="list">
                  <tbody>
                    @for (e of exemplars(); track e.traceId + e.ts) {
                      <tr class="click" [routerLink]="['/traces', e.traceId]" [queryParams]="{ around: e.ts, span: e.spanId }">
                        <td class="mono small nowrap muted">{{ e.ts | time: true }}</td>
                        <td class="r mono nowrap"><span class="val">{{ exemplarValue(e.value, selectedInfo()?.unit) }}</span></td>
                        <td class="nowrap">{{ e.service }}</td>
                        <td class="muted small ellipsis attrs" [title]="describeAttrs(e.attributes)">{{ describeAttrs(e.attributes) }}</td>
                        <td class="nowrap r">
                          <a class="open" [routerLink]="['/traces', e.traceId]" [queryParams]="{ around: e.ts, span: e.spanId }" (click)="$event.stopPropagation()">
                            Ouvrir la trace<wl-nav-icon name="arrow-right" [size]="13" />
                          </a>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          } @else if (!listLoaded()) {
            <div class="chart-head"><i class="skeleton" style="width: 38px; height: 38px; border-radius: 12px"></i><i class="skeleton" style="width: 40%; height: 14px"></i></div>
            <i class="skeleton chart-ghost" aria-busy="true"></i>
          } @else {
            <div class="empty">
              @if (metrics().length) { Choisissez une métrique à gauche. }
              @else { Aucune métrique reçue sur la période : les applications instrumentées avec OpenTelemetry les envoient automatiquement. }
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .count { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
      font: 650 11px var(--mono); color: var(--accent); background: var(--accent-soft); }
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; }
    .list-card { display: flex; flex-direction: column; max-height: calc(100vh - 150px); }
    /* Filtre : loupe dans le champ, bouton d'effacement, nombre de résultats. */
    .filter-wrap { position: relative; display: flex; align-items: center; margin: 10px; }
    .f-icon { position: absolute; left: 11px; color: var(--text-3); pointer-events: none; transition: color .2s; }
    .filter-wrap:focus-within .f-icon { color: var(--accent); }
    .filter { flex: 1; padding-left: 32px; padding-right: 30px; }
    .clear { position: absolute; right: 7px; display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 50%;
      background: var(--surface-3); color: var(--text-2); cursor: pointer; animation: pop .3s var(--spring); transition: background-color .15s, color .15s; }
    .clear:hover { background: var(--accent-soft); color: var(--text-1); }
    @keyframes pop { from { opacity: 0; transform: scale(.4); } }
    .matches { margin: -4px 14px 6px; }
    .names { overflow: auto; padding: 0 6px 8px; }
    .name { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border: 0; border-radius: 9px; background: none;
      color: var(--text-2); font: 12px var(--mono); cursor: pointer; text-align: left;
      transition: background-color .15s, color .15s, transform .3s var(--spring); animation: name-in .35s var(--ease) backwards;
      animation-delay: min(calc(var(--i) * 12ms), 240ms); }
    @keyframes name-in { from { opacity: 0; transform: translateX(-6px); } }
    .name:hover { background: var(--surface-3); color: var(--text-1); transform: translateX(3px); }
    .name:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .name.on { color: var(--text-1); background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 24%, transparent), color-mix(in srgb, var(--accent) 4%, transparent)); }
    .name.on::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; border-radius: 3px; background: var(--accent);
      animation: edge-in .35s var(--spring); }
    @keyframes edge-in { from { transform: scaleY(0); } }
    .t-icon { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 7px; color: var(--text-3); background: var(--surface-2);
      transition: color .2s, background-color .2s, transform .35s var(--spring); }
    .name:hover .t-icon { transform: rotate(-8deg); }
    .name.on .t-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .label { flex: 1; min-width: 0; }
    .hit { color: var(--accent); font-weight: 650; background: var(--accent-soft); border-radius: 3px; }
    .type { font: 11px var(--sans); color: var(--text-3); white-space: nowrap; }
    .none { display: grid; justify-items: center; gap: 8px; padding: 24px 12px; }
    /* Graphique */
    .chart { padding: 14px; min-width: 0; }
    .chart-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .m-icon { display: grid; place-items: center; width: 38px; height: 38px; flex: none; border-radius: 12px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -8px var(--accent), inset 0 1px 0 rgb(255 255 255 / .35);
      animation: icon-pop .5s var(--spring) backwards; }
    @keyframes icon-pop { from { opacity: 0; transform: scale(.5) rotate(-15deg); } }
    .m-title { display: grid; gap: 3px; min-width: 0; max-width: 100%; }
    .m-title h2 { margin: 0; font-family: var(--mono); font-weight: 550; font-size: 14px; }
    .m-meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .chip { flex: none; padding: 0 8px; border-radius: 999px; font: 600 10.5px/18px var(--sans); color: var(--accent); background: var(--accent-soft); }
    .chip.unit { font-family: var(--mono); color: var(--text-2); background: var(--surface-3); }
    .group-by { display: inline-flex; align-items: center; gap: 6px; }
    .spacer { flex: 1; }
    .chart-ghost { height: 360px; border-radius: var(--radius-sm); }
    .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin-top: 10px; }
    .foot span { display: inline-flex; align-items: center; gap: 5px; }
    .state { display: grid; justify-items: center; gap: 8px; }
    .exemplars { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 12px; }
    .exemplars h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
    .exemplars h3 wl-nav-icon { color: var(--accent); }
    .attrs { max-width: 0; width: 50%; }
    .val { padding: 1px 7px; border-radius: 6px; color: var(--text-1); background: var(--surface-3); }
    .open { display: inline-flex; align-items: center; gap: 5px; }
    .open wl-nav-icon { transition: transform .35s var(--spring); }
    tr:hover .open wl-nav-icon { transform: translateX(3px); }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .list-card { max-height: 320px; } }
  `,
})
export class MetricsPage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  protected readonly state = inject(AppState);
  /** Traces d'exemple : seulement si le profil d'accès ouvre les traces (ou les requêtes). */
  protected readonly session = inject(Session);
  /** Paramètre d'URL (recherche globale) : métrique à ouvrir. */
  readonly name = input<string>('');
  private readonly names = viewChild<ElementRef<HTMLElement>>('names');
  protected readonly metrics = signal<MetricInfo[]>([]);
  protected readonly listLoaded = signal(false);
  protected readonly selected = signal<string>(readMetric());
  protected readonly groupBy = signal('service');
  protected readonly stat = signal('p95');
  protected readonly keys = signal<string[]>([]);
  protected readonly data = signal<MetricData | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly filter = signal('');
  private sub?: Subscription;
  private revealed = false;

  /** Métriques dont le nom contient le texte du filtre (sans tenir compte de la casse). */
  protected readonly filtered = computed(() => {
    const f = this.filter().trim().toLowerCase();
    return f ? this.metrics().filter((m) => m.name.toLowerCase().includes(f)) : this.metrics();
  });
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
        this.api.metrics(this.state.range(), this.state.service()).subscribe({
          next: (m) => {
            this.metrics.set(m);
            this.listLoaded.set(true);
            if (!m.some((x) => x.name === this.selected()) && m.length) this.select(pickDefault(m));
            else this.loadSeries();
            this.revealSelected();
          },
          error: () => this.listLoaded.set(true),
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
    // Autre métrique : squelette plutôt que la courbe précédente pendant le chargement.
    if (name !== this.selected() || !this.data()) {
      this.data.set(null);
      this.exemplars.set([]);
    }
    this.selected.set(name);
    try { localStorage.setItem('wolflog.metric', name); } catch { /* ignoré */ }
    this.groupBy.set('service');
    this.api.metricKeys(this.state.range(), name).subscribe((k) => this.keys.set(k));
    this.loadSeries();
  }

  protected retry() {
    this.loadSeries();
  }

  private loadSeries() {
    const name = this.selected();
    if (!name) return;
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.failed.set(false);
    this.api.metricExemplars(this.state.range(), name, this.state.service()).subscribe({
      next: (e) => this.exemplars.set(e),
      error: () => this.exemplars.set([]),
    });
    this.sub = this.api.metricSeries(this.state.range(), name, this.state.service(), this.groupBy(), this.stat()).subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        if (!this.data()) this.failed.set(true);
      },
    });
  }

  /** Au premier affichage, la métrique choisie (mémorisée) est amenée dans la partie visible de la liste. */
  private revealSelected() {
    if (this.revealed) return;
    this.revealed = true;
    afterNextRender(() => this.names()?.nativeElement.querySelector('.name.on')?.scrollIntoView({ block: 'nearest' }), { injector: this.injector });
  }

  /** Flèches haut / bas dans la liste : passe à la métrique voisine. */
  protected step(event: Event, dir: 1 | -1) {
    event.preventDefault();
    const el = event.target as HTMLElement;
    const next = (dir > 0 ? el.nextElementSibling : el.previousElementSibling) as HTMLButtonElement | null;
    if (next?.classList.contains('name')) {
      next.focus();
      next.click();
    }
  }

  /** Flèche bas dans le filtre : entre dans la liste. */
  protected focusFirst(event: Event) {
    event.preventDefault();
    this.names()?.nativeElement.querySelector<HTMLButtonElement>('.name')?.focus();
  }

  /** Entrée dans le filtre : ouvre la première métrique trouvée. */
  protected pickFirst() {
    const first = this.filtered()[0];
    if (first) this.select(first.name);
  }

  /** Nom découpé autour du texte filtré (mis en évidence). */
  protected parts(name: string): { text: string; match: boolean }[] {
    const f = this.filter().trim();
    const i = f ? name.toLowerCase().indexOf(f.toLowerCase()) : -1;
    if (i < 0) return [{ text: name, match: false }];
    return [
      { text: name.slice(0, i), match: false },
      { text: name.slice(i, i + f.length), match: true },
      { text: name.slice(i + f.length), match: false },
    ].filter((p) => p.text);
  }

  type(t: number) { return TYPES[t] ?? ''; }

  protected typeIcon(t: number) { return TYPE_ICONS[t] ?? 'metrics'; }

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
  try { return localStorage.getItem('wolflog.metric') ?? ''; } catch { return ''; }
}
