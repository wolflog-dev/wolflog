import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Observable, Subscription, map } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { Api } from '../core/api';
import { sectionInfo, sourceSections } from '../core/access';
import { CustomRow, CustomView, ErrorGroup, LogItem, MetricData, Panel } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { LEVEL_COLORS, LEVELS, formatDuration, formatNumber } from '../core/format';
import { NumPipe } from '../core/pipes/num-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { Chart, ChartSeries, paletteColor } from './chart';
import { CountUp } from './count-up';
import { LevelBadge } from './level-badge';
import { NavIcon } from './nav-icon';
import { Skeleton } from './skeleton';

export const PANEL_HEIGHTS: Record<string, number> = { s: 120, m: 220, l: 380 };

/** Calculs proposés (requêtes personnalisées, alertes) ; icône et description pour les listes riches. */
export const AGGREGATES: { value: string; label: string; numeric: boolean; icon: string; desc: string }[] = [
  { value: 'count', label: 'Nombre', numeric: false, icon: 'hash', desc: 'Nombre d’éléments' },
  { value: 'rate', label: 'Nombre par seconde', numeric: false, icon: 'bolt', desc: 'Débit moyen sur chaque intervalle' },
  { value: 'distinct', label: 'Valeurs distinctes de…', numeric: false, icon: 'layers', desc: 'Nombre de valeurs différentes d’un champ' },
  { value: 'avg', label: 'Moyenne de…', numeric: true, icon: 'gauge', desc: 'Champ numérique' },
  { value: 'sum', label: 'Somme de…', numeric: true, icon: 'sigma', desc: 'Total d’un champ numérique' },
  { value: 'min', label: 'Minimum de…', numeric: true, icon: 'arrow-down', desc: 'Plus petite valeur' },
  { value: 'max', label: 'Maximum de…', numeric: true, icon: 'arrow-up', desc: 'Plus grande valeur' },
  { value: 'p50', label: 'Médiane (p50) de…', numeric: true, icon: 'timer', desc: 'La moitié des valeurs est en dessous' },
  { value: 'p75', label: 'p75 de…', numeric: true, icon: 'timer', desc: '75 % des valeurs sont en dessous' },
  { value: 'p90', label: 'p90 de…', numeric: true, icon: 'timer', desc: '90 % des valeurs sont en dessous' },
  { value: 'p95', label: 'p95 de…', numeric: true, icon: 'timer', desc: '95 % des valeurs sont en dessous' },
  { value: 'p99', label: 'p99 de…', numeric: true, icon: 'timer', desc: 'Les valeurs les plus hautes' },
];

const STATUS_CLASS_COLORS: Record<string, string> = { '1': '#6f747e', '2': '#5a6780', '3': '#7aa2f7', '4': '#c9973f', '5': '#d45f5f' };

/** Icône de chaque affichage d'une requête personnalisée. */
export const VIEW_ICONS: Record<CustomView, string> = { timeseries: 'chart-line', bars: 'chart-bar', top: 'list', table: 'table', stat: 'number' };

/** Icône d'un panneau selon ce qu'il montre (en-têtes du tableau de bord, éditeur). */
export function panelIcon(p: Panel): string {
  switch (p.type) {
    case 'custom': return VIEW_ICONS[p.view ?? 'timeseries'] ?? 'chart-line';
    case 'http': return 'requests';
    case 'stat': return 'number';
    case 'metric': return 'metrics';
    case 'logs': return 'chart-bar';
    case 'logs-table': return 'logs';
    case 'errors': return 'errors';
    default: return 'chart-line';
  }
}

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
  const q: Record<string, string> = { name: p.title };
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

/** Parties de Wolflog dont un panneau lit les données (l'une suffit) : même règle que le serveur (profils d'accès). */
export function panelSections(p: Panel): string[] {
  switch (p.type) {
    case 'custom': return sourceSections(p.dataSource);
    case 'http': return ['requests'];
    case 'metric': return ['metrics'];
    case 'logs':
    case 'logs-table': return ['logs'];
    case 'errors': return ['errors'];
    default: return p.source === 'logs' ? ['logs'] : p.source === 'errors' ? ['errors'] : ['requests'];
  }
}

type Data =
  | { kind: 'series'; times: string[]; series: ChartSeries[]; unit: string | null; bars: boolean; stacked: boolean }
  | { kind: 'rank' | 'table'; rows: CustomRow[]; unit: string | null; label: string }
  | { kind: 'logs'; items: LogItem[] }
  | { kind: 'errors'; items: ErrorGroup[] }
  | { kind: 'stat'; value: string; hint: string };

/** Forme attendue des données (squelette de chargement adapté au contenu). */
type Shape = 'chart' | 'stat' | 'rows';

/** Hauteurs (en %) des barres du squelette de graphique : irrégulières, mais stables. */
const GHOST_BARS = [38, 52, 44, 61, 57, 72, 49, 66, 80, 63, 55, 70, 46, 58, 75, 68, 52, 41, 60, 54, 66, 48, 39, 57];

/** Un panneau de tableau de bord : charge ses données selon son type, suit la période et les filtres globaux. */
@Component({
  selector: 'wl-dashboard-panel',
  imports: [Chart, LevelBadge, NumPipe, TimePipe, AgoPipe, RouterLink, NavIcon, Skeleton, CountUp],
  template: `
    <div class="body" [style.min-height.px]="height()">
      @if (denied(); as d) {
        <div class="empty small state denied" role="note">
          <span class="denied-lock"><wl-nav-icon name="lock" [size]="16" /></span>
          <strong>Pas d'accès à cette source</strong>
          <span>{{ d }} · hors de votre profil d'accès</span>
        </div>
      } @else if (error()) {
        <div class="empty small danger state">
          <wl-nav-icon name="warning" [size]="20" class="state-icon" />
          <span>{{ error() }}</span>
          @if (retryable()) {
            <button class="btn ghost small" type="button" (click)="reload()"><wl-nav-icon name="refresh" [size]="13" />Réessayer</button>
          }
        </div>
      } @else {
        @switch (data()?.kind) {
          @case ('series') {
            @let d = asSeries();
            @if (d.series.length) {
              <wl-chart [times]="d.times" [series]="d.series" [kind]="d.bars ? 'bars' : 'lines'" [stacked]="d.stacked"
                        [height]="height()" [unit]="d.unit" [legend]="panel().height !== 's'"
                        (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
            } @else {
              <div class="empty small state"><wl-nav-icon name="chart-line" [size]="20" class="state-icon" />Aucune donnée sur cette période.</div>
            }
          }
          @case ('rank') {
            @let d = asRows();
            <div class="rank" [style.max-height.px]="height()">
              @for (r of d.rows; track r.group; let i = $index) {
                <div class="rank-row" [class.link]="drillable()" [style.--i]="i" (click)="drill(r.group)"
                     [title]="r.group + ' : ' + fmt(r.value, d.unit) + (drillable() ? '\\nCliquer pour voir les logs' : '')">
                  <span class="label ellipsis">{{ r.group }}</span>
                  <span class="track"><span class="bar" [style.transform]="'scaleX(' + share(r.value, d.rows) + ')'" [style.background]="color(r.group, i)"></span></span>
                  <span class="value">{{ fmt(r.value, d.unit) }}</span>
                  @if (drillable()) { <wl-nav-icon name="chevron-right" [size]="13" class="go" /> }
                </div>
              } @empty {
                <div class="empty small state"><wl-nav-icon name="list" [size]="20" class="state-icon" />Aucune donnée sur cette période.</div>
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
                    @for (r of d.rows; track r.group; let i = $index) {
                      <tr [class.click]="drillable()" (click)="drill(r.group)" [title]="drillable() ? 'Voir les logs : ' + r.group : ''">
                        <td class="mono ellipsis cell">{{ r.group }}</td>
                        <td class="r nowrap">{{ fmt(r.value, d.unit) }}</td>
                        <td class="r muted nowrap">
                          <span class="part">
                            <span class="mini"><i [style.transform]="'scaleX(' + ratio(r.value, d.rows) + ')'" [style.background]="color(r.group, i)"></i></span>
                            {{ percent(r.value, d.rows) }}
                          </span>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <div class="empty small state"><wl-nav-icon name="table" [size]="20" class="state-icon" />Aucune donnée sur cette période.</div>
              }
            </div>
          }
          @case ('stat') {
            @let d = asStat();
            <div class="stat" [class.compact]="height() < 150">
              <span class="stat-icon"><wl-nav-icon [name]="statIcon()" [size]="height() < 150 ? 16 : 20" /></span>
              <div class="stat-text">
                <strong [wlCountUp]="d.value" [style.font-size.px]="statSize()"></strong>
                <span class="ellipsis" [title]="d.hint">{{ d.hint }}</span>
              </div>
            </div>
          }
          @case ('logs') {
            <div class="rows" [style.max-height.px]="height()">
              @for (l of asLogs(); track $index; let i = $index) {
                <div class="row small" [style.--i]="i" [title]="clip(l.body)"><span class="mono muted">{{ l.ts | time }}</span><wl-level [level]="l.level" /><span class="mono ellipsis">{{ l.body }}</span></div>
              } @empty {
                <div class="empty small state"><wl-nav-icon name="logs" [size]="20" class="state-icon" />Aucun log.</div>
              }
            </div>
          }
          @case ('errors') {
            <div class="rows" [style.max-height.px]="height()">
              @for (e of asErrors(); track e.fingerprint; let i = $index) {
                <a class="row small err" [style.--i]="i" [routerLink]="['/errors', e.fingerprint]" [title]="e.exceptionType + (e.message ? '\\n' + clip(e.message) : '')">
                  <span class="mono ellipsis">@if (e.crashes) { <span class="tag crash">crash</span> } {{ e.exceptionType }}</span>
                  <span class="ellipsis muted">{{ e.message }}</span>
                  <span class="r count">{{ e.count | num }}</span>
                  <span class="muted nowrap">{{ e.lastSeen | ago }}</span>
                </a>
              } @empty {
                <div class="empty small state good"><wl-nav-icon name="ok" [size]="20" class="state-icon" />Aucune erreur à traiter.</div>
              }
            </div>
          }
          @default {
            @switch (shape()) {
              @case ('stat') {
                <div class="stat ghost" aria-busy="true">
                  <i class="skeleton ghost-icon"></i>
                  <div class="stat-text"><i class="skeleton" style="width: 55%; height: 26px"></i><i class="skeleton" style="width: 35%; height: 9px"></i></div>
                </div>
              }
              @case ('rows') { <wl-skeleton [rows]="ghostRows()" aria-busy="true" /> }
              @default {
                <div class="ghost-chart skeleton" [style.height.px]="height()" aria-busy="true">
                  @for (h of ghostBars; track $index) { <i [style.height.%]="h"></i> }
                </div>
              }
            }
          }
        }
      }
    </div>
  `,
  styles: `
    .body { position: relative; }
    /* États (vide, erreur) : icône au-dessus du message, centrés dans la hauteur du panneau. */
    .state { display: grid; justify-items: center; align-content: center; gap: 6px; min-height: inherit; padding: 16px 8px; }
    .state-icon { color: var(--text-3); opacity: .8; animation: state-pop .5s var(--spring) backwards; }
    .state.danger .state-icon { color: var(--danger); }
    .state.good .state-icon { color: var(--ok); }
    @keyframes state-pop { from { opacity: 0; transform: scale(.5) rotate(-12deg); } }
    /* Source hors du profil d'accès : état calme (pas une erreur), cadenas dans une pastille. */
    .state.denied { gap: 4px; }
    .state.denied strong { color: var(--text-2); font-size: 12.5px; font-weight: 600; }
    .state.denied span:last-child { font-size: 11.5px; }
    .denied-lock { display: grid; place-items: center; width: 34px; height: 34px; margin-bottom: 4px; border-radius: 50%; color: var(--text-3);
      background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border-soft); animation: state-pop .5s var(--spring) backwards; }
    /* Chiffre clé : pastille d'icône, nombre qui défile, légende. */
    .stat { display: flex; align-items: center; gap: 14px; min-height: inherit; padding: 4px 6px; }
    .stat-icon { display: grid; place-items: center; width: 42px; height: 42px; flex: none; border-radius: 13px; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
      animation: state-pop .55s var(--spring) backwards; }
    .stat.compact .stat-icon { width: 34px; height: 34px; border-radius: 11px; }
    .stat-text { display: grid; gap: 2px; min-width: 0; }
    .stat strong { font-weight: 700; line-height: 1.1; letter-spacing: -.02em; font-variant-numeric: tabular-nums; white-space: nowrap;
      background: linear-gradient(90deg, var(--text-1) 30%, color-mix(in srgb, var(--accent) 75%, var(--text-1)));
      -webkit-background-clip: text; background-clip: text; color: transparent; }
    .stat span { font-size: 11.5px; color: var(--text-3); }
    .stat.ghost .stat-text { width: 100%; gap: 8px; }
    .ghost-icon { width: 42px; height: 42px; flex: none; border-radius: 13px; }
    /* Squelette de graphique : barres grisées sous un seul reflet. */
    .ghost-chart { display: flex; align-items: flex-end; gap: 4px; padding: 10px 8px 0; border-radius: var(--radius-sm); background: transparent; }
    .ghost-chart i { flex: 1; border-radius: 4px 4px 0 0; background: var(--surface-2); }
    .rows, .rank, .table-wrap { overflow: auto; }
    .row { display: grid; grid-template-columns: 90px 30px minmax(0, 1fr); gap: 10px; align-items: center; padding: 4px 6px;
      border-bottom: 1px solid var(--border-soft); color: inherit; transition: background-color .15s;
      animation: row-in .35s var(--ease) backwards; animation-delay: min(calc(var(--i) * 18ms), 300ms); }
    .row:hover { background: var(--row-hover); }
    @keyframes row-in { from { opacity: 0; transform: translateY(4px); } }
    .row.err { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 60px 90px; }
    .row.err:hover { text-decoration: none; box-shadow: inset 3px 0 0 var(--accent); }
    .row.err .count { font-weight: 600; }
    /* Classement : barres qui se déploient (transform), survol avec chevron. */
    .rank-row { display: grid; grid-template-columns: minmax(80px, 38%) minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 4px 6px;
      border-radius: 8px; font-size: 12.5px; transition: background-color .15s; animation: row-in .35s var(--ease) backwards;
      animation-delay: min(calc(var(--i) * 25ms), 300ms); }
    .rank-row.link { grid-template-columns: minmax(80px, 38%) minmax(0, 1fr) auto 13px; cursor: pointer; }
    .rank-row:hover { background: var(--row-hover); }
    .rank-row:hover .label { color: var(--text-1); }
    .rank-row:hover .bar { opacity: 1; }
    .label { font-family: var(--mono); font-size: 12px; color: var(--text-2); transition: color .15s; }
    .track { height: 8px; background: var(--surface-3); border-radius: 999px; overflow: hidden; }
    .bar { display: block; width: 100%; height: 100%; transform-origin: left; opacity: .85; transition: opacity .2s, transform .5s var(--ease);
      animation: bar-grow .7s var(--ease) backwards; animation-delay: min(calc(var(--i) * 30ms + 80ms), 400ms); }
    @keyframes bar-grow { from { transform: scaleX(0); } }
    .value { font-variant-numeric: tabular-nums; min-width: 60px; text-align: right; }
    .go { color: var(--accent); opacity: 0; transform: translateX(-4px); transition: opacity .2s, transform .3s var(--spring); }
    .rank-row:hover .go { opacity: 1; transform: none; }
    .cell { max-width: 0; width: 60%; }
    .r { text-align: right; font-variant-numeric: tabular-nums; }
    .part { display: inline-flex; align-items: center; gap: 8px; }
    .mini { display: inline-block; width: 42px; height: 4px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .mini i { display: block; width: 100%; height: 100%; transform-origin: left; opacity: .8; animation: bar-grow .7s var(--ease) backwards; }
    table.list td { padding: 4px 8px; }
    table.list th { padding: 5px 8px; }
    .tag { margin-right: 4px; }
  `,
})
export class DashboardPanel implements OnDestroy {
  protected readonly state = inject(AppState);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  readonly panel = input.required<Panel>();
  /** Hauteur forcée (aperçu dans l'éditeur, panneau agrandi). */
  readonly heightOverride = input<number | null>(null);

  protected readonly data = signal<Data | null>(null);
  protected readonly error = signal('');
  /** Source hors du profil d'accès : nom de la partie (aucune requête envoyée, aucune erreur affichée). */
  protected readonly denied = signal<string | null>(null);
  /** Erreur de chargement (le bouton « Réessayer » a un sens), par opposition à un panneau incomplet. */
  protected readonly retryable = signal(false);
  protected readonly height = computed(() => this.heightOverride() ?? PANEL_HEIGHTS[this.panel().height] ?? PANEL_HEIGHTS['m']);
  protected readonly drillable = computed(() => {
    const p = this.panel();
    return p.type === 'custom' && (p.dataSource ?? 'logs') === 'logs' && !!p.groupBy;
  });
  /** Forme du contenu attendu, connue avant les données (squelette de la bonne forme). */
  protected readonly shape = computed<Shape>(() => {
    const p = this.panel();
    const view = p.view ?? 'timeseries';
    if (p.type === 'stat' || (p.type === 'custom' && view === 'stat')) return 'stat';
    if (p.type === 'logs-table' || p.type === 'errors' || (p.type === 'custom' && (view === 'top' || view === 'table'))) return 'rows';
    return 'chart';
  });
  protected readonly ghostBars = GHOST_BARS;
  protected readonly ghostRows = computed(() => Math.max(2, Math.min(8, Math.floor(this.height() / 34))));
  /** Taille du chiffre clé selon la hauteur du panneau. */
  protected readonly statSize = computed(() => (this.height() < 150 ? 28 : this.height() < 260 ? 38 : 50));
  /** Icône du chiffre clé : ce qu'il compte. */
  protected readonly statIcon = computed(() => {
    const p = this.panel();
    if (p.type === 'custom') return AGGREGATES.find((a) => a.value === (p.aggregate ?? 'count'))?.icon ?? 'number';
    if (p.source === 'logs') return 'logs';
    if (p.source === 'errors') return 'errors';
    return ({ count: 'hash', errorRate: 'percent', p50: 'timer', p95: 'timer', p99: 'timer' } as Record<string, string>)[p.stat ?? ''] ?? 'bolt';
  });
  private sub?: Subscription;
  private lastShape: Shape | null = null;

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
      this.session.sections(); // profil d'accès changé : le panneau est réévalué
      untracked(() => this.load());
    });
  }

  protected fmt = formatValue;
  protected color = seriesColor;

  /** Part de la plus grande valeur (0–1), pour la longueur des barres. */
  protected share(v: number | null, rows: CustomRow[]) {
    const max = Math.max(...rows.map((r) => r.value ?? 0), 0);
    return max > 0 ? Math.max(0.01, (v ?? 0) / max) : 0.01;
  }

  /** Part du total (0–1), pour la mini-barre de la colonne « Part ». */
  protected ratio(v: number | null, rows: CustomRow[]) {
    const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
    return total > 0 ? Math.max(0.02, (v ?? 0) / total) : 0;
  }

  protected percent(v: number | null, rows: CustomRow[]) {
    const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
    return total > 0 ? `${(((v ?? 0) / total) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : '–';
  }

  /** Texte d'info-bulle raisonnable pour un message très long. */
  protected clip(text: string | null | undefined) {
    const t = text ?? '';
    return t.length > 280 ? t.slice(0, 280) + '…' : t;
  }

  /** Ouvre les logs correspondant à une valeur du regroupement. */
  protected drill(group: string) {
    if (!this.drillable()) return;
    const p = this.panel();
    const value = /\s/.test(group) ? `"${group}"` : group;
    const q = [p.query, group === '(vide)' ? '' : `${p.groupBy}:${value}`].filter(Boolean).join(' ');
    this.router.navigate(['/logs'], { queryParams: { q } });
  }

  protected reload() {
    this.load();
  }

  private load() {
    this.sub?.unsubscribe();
    this.error.set('');
    this.retryable.set(false);
    const p = this.panel();
    // Source hors du profil d'accès : rien n'est demandé au serveur (qui refuserait).
    const needed = panelSections(p);
    const deniedLabel = sectionInfo(needed[0])?.label ?? 'Cette source';
    this.denied.set(this.session.can(needed) ? null : deniedLabel);
    if (this.denied()) {
      this.data.set(null);
      this.lastShape = null;
      return;
    }
    const r = this.state.range();
    const service = p.service || this.state.service();
    // Contenu d'une autre forme (ex. chiffre → tableau) : squelette plutôt que l'ancien affichage.
    const shape = this.shape();
    if (shape !== this.lastShape) this.data.set(null);
    this.lastShape = shape;
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
        // Refus du profil d'accès (changé depuis l'ouverture de la page) : même état calme qu'une source fermée.
        if (e instanceof HttpErrorResponse && e.status === 403) {
          this.data.set(null);
          this.denied.set(sectionInfo(e.error?.section)?.label ?? deniedLabel);
          return;
        }
        const message = e instanceof HttpErrorResponse && typeof e.error?.error === 'string' ? e.error.error : 'Impossible de charger ce panneau.';
        this.error.set(message);
        this.retryable.set(true);
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
