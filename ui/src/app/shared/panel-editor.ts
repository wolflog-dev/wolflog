import { Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { CustomView, DataSource, FieldInfo, FieldValue, MetricInfo, Panel, PanelType } from '../core/models';
import { AppState } from '../core/app-state';
import { formatNumber } from '../core/format';
import { AGGREGATES, DashboardPanel, VIEW_ICONS, describeAggregate, panelIcon } from './dashboard-panel';
import { NavIcon } from './nav-icon';
import { RichOption } from './rich-option';

export const PANEL_TYPES: { value: PanelType; label: string; icon: string; desc: string }[] = [
  { value: 'custom', label: 'Requête personnalisée', icon: 'sparkles', desc: 'À partir des logs, traces ou métriques' },
  { value: 'http', label: 'Requêtes HTTP', icon: 'requests', desc: 'Courbe par route, statut, méthode…' },
  { value: 'stat', label: 'Chiffre clé', icon: 'number', desc: 'Un nombre : HTTP, logs ou erreurs' },
  { value: 'metric', label: 'Métrique OpenTelemetry', icon: 'metrics', desc: 'Courbe d’une métrique reçue' },
  { value: 'logs', label: 'Logs : histogramme', icon: 'chart-bar', desc: 'Volume par niveau dans le temps' },
  { value: 'logs-table', label: 'Logs : derniers messages', icon: 'logs', desc: 'Liste des logs les plus récents' },
  { value: 'errors', label: 'Erreurs regroupées', icon: 'errors', desc: 'Exceptions à traiter, les plus fréquentes' },
];

const SOURCES: { value: DataSource; label: string; icon: string; hint: string }[] = [
  { value: 'logs', label: 'Logs', icon: 'logs', hint: 'ex. level:warn http.route:/api/* timeout' },
  { value: 'spans', label: 'Traces', icon: 'traces', hint: 'ex. kind:serveur http.response.status_code:500 GET' },
  { value: 'metrics', label: 'Métriques', icon: 'metrics', hint: 'ex. name:http.server.request.duration' },
];

const VIEWS: { value: CustomView; label: string; icon: string }[] = [
  { value: 'timeseries', label: 'Courbe', icon: VIEW_ICONS.timeseries },
  { value: 'bars', label: 'Barres', icon: VIEW_ICONS.bars },
  { value: 'top', label: 'Classement', icon: VIEW_ICONS.top },
  { value: 'table', label: 'Tableau', icon: VIEW_ICONS.table },
  { value: 'stat', label: 'Chiffre', icon: VIEW_ICONS.stat },
];

/** Icône par type de métrique OpenTelemetry (jauge, compteur, histogramme, histogramme exp., résumé). */
const METRIC_ICONS = ['metrics', 'gauge', 'hash', 'chart-bar', 'chart-bar', 'sigma'];

export function newPanel(): Panel {
  return {
    id: Math.random().toString(36).slice(2, 10), title: 'Nombre de logs par niveau', type: 'custom', width: 6, height: 'm',
    dataSource: 'logs', aggregate: 'count', groupBy: 'level', view: 'bars', limit: 10, outgoing: false, statusClass: null, level: null, source: 'http',
  };
}

/**
 * Formulaire d'un panneau avec aperçu en direct. Travaille sur une copie : rien n'est modifié avant "Appliquer".
 * Tiroir en verre qui glisse depuis la droite ; pour une sortie animée, le parent pose animate.leave="editor-out" sur l'élément.
 */
@Component({
  selector: 'wl-panel-editor',
  imports: [FormsModule, DashboardPanel, NavIcon, RichOption],
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <aside class="drawer panel" role="dialog" aria-modal="true" [attr.aria-label]="isNew() ? 'Nouveau panneau' : 'Configurer le panneau'">
      <div class="panel-head head">
        <span class="head-icon"><wl-nav-icon [name]="icon()" [size]="18" /></span>
        <div class="head-text">
          <h2>{{ isNew() ? 'Nouveau panneau' : 'Configurer le panneau' }}</h2>
          <span class="muted small ellipsis" [title]="draft().title">{{ draft().title || 'Sans titre' }}</span>
        </div>
        <span class="spacer"></span>
        <button class="btn ghost square" type="button" (click)="cancel.emit()" title="Fermer (Échap)" aria-label="Fermer"><wl-nav-icon name="close" /></button>
      </div>

      <form class="form" (ngSubmit)="submit()" (input)="changed()" (change)="changed()">
        <label>Type de panneau
          <select name="type" [(ngModel)]="p.type" (ngModelChange)="onType()">
            @for (t of types; track t.value) { <option [value]="t.value" [wlOpt]="t.label" [icon]="t.icon" [desc]="t.desc"></option> }
          </select>
        </label>

        @if (p.type === 'custom') {
          <fieldset>
            <legend><wl-nav-icon name="database" [size]="13" />Données</legend>
            <div class="seg">
              @for (s of sources; track s.value) {
                <button type="button" [class.on]="p.dataSource === s.value" (click)="setSource(s.value)"><wl-nav-icon [name]="s.icon" [size]="13" />{{ s.label }}</button>
              }
            </div>
            <label>Filtre <span class="muted">(même syntaxe que la recherche, vide = tout)</span>
              <input name="filter" class="mono" [(ngModel)]="p.query" [placeholder]="sourceHint()" />
            </label>
            <div class="suggest">
              <select name="suggestField" [ngModel]="suggestField()" (ngModelChange)="loadValues($event)" aria-label="Ajouter une condition">
                <option value="" wlOpt="Ajouter une condition sur…" icon="filter" tone="muted" desc="Choisir un champ, puis une valeur proposée"></option>
                @for (f of textFields(); track f.key) {
                  <option [value]="f.key" [wlOpt]="f.label" icon="text" [meta]="f.builtin ? null : formatNumber(f.seen)" metaTone="muted"></option>
                }
              </select>
              @if (values().length) {
                <div class="chips">
                  @for (v of values(); track v.value; let i = $index) {
                    <button type="button" class="chip" [class.on]="hasCondition(v.value)" [style.--i]="i" (click)="addCondition(v.value)"
                            [title]="formatNumber(v.count) + ' élément(s)  ' + (hasCondition(v.value) ? 'retirer du filtre' : 'ajouter au filtre')">
                      <wl-nav-icon [name]="hasCondition(v.value) ? 'check' : 'plus'" [size]="11" class="chip-icon" />
                      <span class="ellipsis">{{ v.value }}</span><span class="chip-count">{{ formatNumber(v.count) }}</span>
                    </button>
                  }
                </div>
              } @else if (loadingValues()) {
                <div class="chips" aria-busy="true">
                  @for (w of [72, 96, 58, 84]; track $index) { <i class="skeleton chip-ghost" [style.width.px]="w"></i> }
                </div>
              }
            </div>
          </fieldset>

          <fieldset>
            <legend><wl-nav-icon name="sigma" [size]="13" />Calcul</legend>
            <div class="two">
              <label>Mesure
                <select name="agg" [(ngModel)]="p.aggregate" (ngModelChange)="onAggregate()">
                  @for (a of aggregates; track a.value) { <option [value]="a.value" [wlOpt]="a.label" [icon]="a.icon" [desc]="a.desc"></option> }
                </select>
              </label>
              @if (needsNumber()) {
                <label>Champ numérique
                  <select name="field" [(ngModel)]="p.field">
                    @for (f of numberFields(); track f.key) {
                      <option [value]="f.key" [wlOpt]="f.label" icon="hash" [meta]="f.builtin ? null : formatNumber(f.seen)" metaTone="muted"></option>
                    }
                  </select>
                </label>
              } @else if (p.aggregate === 'distinct') {
                <label>Champ
                  <select name="field" [(ngModel)]="p.field">
                    @for (f of textFields(); track f.key) {
                      <option [value]="f.key" [wlOpt]="f.label" icon="text" [meta]="f.builtin ? null : formatNumber(f.seen)" metaTone="muted"></option>
                    }
                  </select>
                </label>
              }
            </div>
            @if (needsNumber() && !numberFields().length) {
              <p class="muted small note"><wl-nav-icon name="info" [size]="13" />Aucun champ numérique trouvé dans ces données sur la période.</p>
            }
            <label>Grouper par
              <select name="groupBy" [(ngModel)]="p.groupBy">
                <option [ngValue]="null" wlOpt="Aucun regroupement" icon="sigma" desc="Une seule série : le total"></option>
                @for (f of textFields(); track f.key) {
                  <option [value]="f.key" [wlOpt]="f.label" icon="split" [meta]="f.builtin ? null : formatNumber(f.seen)" metaTone="muted"></option>
                }
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend><wl-nav-icon name="eye" [size]="13" />Affichage</legend>
            <div class="seg views">
              @for (v of views; track v.value) {
                <button type="button" [class.on]="p.view === v.value" (click)="setView(v.value)"><wl-nav-icon [name]="v.icon" [size]="13" />{{ v.label }}</button>
              }
            </div>
            @if (p.view !== 'stat' && p.groupBy) {
              <label class="inline">Groupes affichés au maximum <input name="limit" type="number" min="1" max="50" [(ngModel)]="p.limit" class="num-input" /></label>
            }
          </fieldset>
        }

        @if (p.type === 'stat') {
          <label>Source
            <select name="source" [(ngModel)]="p.source">
              <option value="http" wlOpt="Requêtes HTTP" icon="requests" desc="Débit, erreurs ou latence"></option>
              <option value="logs" wlOpt="Nombre de logs" icon="logs" desc="Selon une recherche et un niveau"></option>
              <option value="errors" wlOpt="Nombre d'exceptions" icon="errors" tone="danger" desc="Erreurs à traiter"></option>
            </select>
          </label>
        }

        @if (p.type === 'http' || (p.type === 'stat' && (p.source ?? 'http') === 'http')) {
          <div class="group">
            <div class="two">
              <label>Sens
                <select name="outgoing" [(ngModel)]="p.outgoing">
                  <option [ngValue]="false" wlOpt="Reçues (serveur)" icon="server" desc="Requêtes traitées par vos services"></option>
                  <option [ngValue]="true" wlOpt="Sortantes (HttpClient)" icon="globe" desc="Appels vers d'autres services ou API"></option>
                </select>
              </label>
              <label>Mesure
                <select name="stat" [(ngModel)]="p.stat">
                  <option value="rate" wlOpt="Débit (req/s)" icon="bolt"></option>
                  @if (p.type === 'stat') { <option value="count" wlOpt="Nombre de requêtes" icon="hash"></option> }
                  @if (p.type === 'http') { <option value="errors" wlOpt="Erreurs (req/s)" icon="errors" tone="danger"></option> }
                  <option value="errorRate" wlOpt="Taux d'erreur (%)" icon="percent" tone="danger"></option>
                  <option value="p50" wlOpt="Latence p50" icon="timer" desc="Médiane"></option>
                  <option value="p95" wlOpt="Latence p95" icon="timer" desc="95 % des requêtes sont plus rapides"></option>
                  <option value="p99" wlOpt="Latence p99" icon="timer" desc="Les requêtes les plus lentes"></option>
                  @if (p.type === 'http') { <option value="avg" wlOpt="Latence moyenne" icon="gauge"></option> }
                </select>
              </label>
            </div>
            @if (p.type === 'http') {
              <label>Grouper par
                <select name="groupByHttp" [(ngModel)]="p.groupBy">
                  <option value="route" [wlOpt]="p.outgoing ? 'Hôte appelé' : 'Route'" [icon]="p.outgoing ? 'globe' : 'link'"></option>
                  <option value="status" wlOpt="Code HTTP" icon="hash"></option>
                  <option value="method" wlOpt="Méthode" icon="code" desc="GET, POST…"></option>
                  <option value="service" wlOpt="Service" icon="server"></option>
                  <option value="none" wlOpt="Aucun (total)" icon="sigma"></option>
                </select>
              </label>
            }
            <div class="two">
              <label>Filtre route / URL <input name="query" [(ngModel)]="p.query" placeholder="ex. /api/orders" /></label>
              <label>Statut
                <select name="statusClass" [(ngModel)]="p.statusClass">
                  <option [ngValue]="null" wlOpt="Tous" icon="layers" tone="muted"></option>
                  <option value="2xx" wlOpt="2xx" dot tone="ok" desc="Succès"></option>
                  <option value="4xx" wlOpt="4xx" dot tone="warn" desc="Erreurs du client"></option>
                  <option value="5xx" wlOpt="5xx" dot tone="danger" desc="Erreurs du serveur"></option>
                  <option value="errors" wlOpt="En erreur" icon="errors" tone="danger" desc="Toutes les réponses en échec"></option>
                </select>
              </label>
            </div>
          </div>
        }

        @if (p.type === 'metric') {
          <div class="group">
            <label>Métrique
              <select name="metric" [(ngModel)]="p.metric">
                @for (m of metrics(); track m.name) {
                  <option [value]="m.name" [wlOpt]="m.name" [icon]="metricIcon(m.type)" [desc]="m.description" [meta]="m.unit" metaTone="muted"></option>
                }
              </select>
            </label>
            <div class="two">
              <label>Statistique <span class="muted">(histogrammes)</span>
                <select name="mstat" [(ngModel)]="p.stat">
                  <option [ngValue]="null" wlOpt="Par défaut" icon="sparkles" desc="Selon le type de métrique"></option>
                  <option value="p50" wlOpt="p50" icon="timer" desc="Médiane"></option>
                  <option value="p95" wlOpt="p95" icon="timer"></option>
                  <option value="p99" wlOpt="p99" icon="timer"></option>
                  <option value="avg" wlOpt="Moyenne" icon="gauge"></option>
                  <option value="max" wlOpt="Max" icon="arrow-up"></option>
                  <option value="count" wlOpt="Nombre / s" icon="bolt"></option>
                </select>
              </label>
              <label>Grouper par <input name="mgroup" [(ngModel)]="p.groupBy" placeholder="service, none, http.route…" /></label>
            </div>
          </div>
        }

        @if (p.type === 'logs' || p.type === 'logs-table' || p.type === 'errors' || (p.type === 'stat' && (p.source === 'logs' || p.source === 'errors'))) {
          <div class="group">
            <label>Recherche <input name="lq" [(ngModel)]="p.query" class="mono" placeholder='ex. paiement http.route:/pay/* "délai dépassé"' /></label>
            @if (p.type !== 'errors' && p.source !== 'errors') {
              <label>Niveau minimum
                <select name="level" [(ngModel)]="p.level">
                  <option [ngValue]="null" wlOpt="Tous" icon="layers" tone="muted"></option>
                  <option value="info" wlOpt="Info" dot tone="ok"></option>
                  <option value="warn" wlOpt="Warn" dot tone="warn"></option>
                  <option value="error" wlOpt="Error" dot tone="danger"></option>
                  <option value="fatal" wlOpt="Fatal" dot tone="crash"></option>
                </select>
              </label>
            }
          </div>
        }

        <fieldset>
          <legend><wl-nav-icon name="dashboards" [size]="13" />Présentation</legend>
          <label>Titre <input name="title" [(ngModel)]="p.title" (input)="titleTouched = true" required /></label>
          <div class="three">
            <label>Largeur
              <select name="width" [(ngModel)]="p.width">
                <option [ngValue]="3" wlOpt="1/4" icon="number" desc="Chiffre clé"></option>
                <option [ngValue]="4" wlOpt="1/3" icon="chart-pie" desc="Petit graphique"></option>
                <option [ngValue]="6" wlOpt="1/2" icon="chart-bar" desc="Courbe, classement"></option>
                <option [ngValue]="8" wlOpt="2/3" icon="chart-line" desc="Courbe détaillée"></option>
                <option [ngValue]="12" wlOpt="Pleine largeur" icon="table" desc="Tableaux, logs, erreurs"></option>
              </select>
            </label>
            <label>Hauteur
              <select name="height" [(ngModel)]="p.height">
                <option value="s" wlOpt="Petite" icon="text" desc="120 px : chiffre clé"></option>
                <option value="m" wlOpt="Moyenne" icon="chart-bar" desc="220 px : usage courant"></option>
                <option value="l" wlOpt="Grande" icon="chart-line" desc="380 px : beaucoup de détail"></option>
              </select>
            </label>
            <label>Service
              <input name="service" [(ngModel)]="p.service" list="wl-services" placeholder="filtre global" />
            </label>
          </div>
        </fieldset>

        <div class="preview">
          <div class="preview-head small">
            <span class="live"><wl-nav-icon name="eye" [size]="13" />Aperçu en direct</span>
            <span class="muted">{{ state.label().toLowerCase() }}</span>
          </div>
          <wl-dashboard-panel [panel]="draft()" [heightOverride]="180" />
        </div>

        <div class="actions">
          <button class="btn primary" type="submit" [disabled]="!p.title.trim()">
            <wl-nav-icon [name]="isNew() ? 'plus' : 'check'" [size]="14" />{{ isNew() ? 'Ajouter au tableau' : 'Appliquer' }}
          </button>
          <button class="btn" type="button" (click)="cancel.emit()">Annuler</button>
          <span class="spacer"></span>
          <span class="muted small keys"><kbd>Échap</kbd> pour fermer</span>
        </div>
      </form>
      <datalist id="wl-services">
        @for (s of services(); track s) { <option [value]="s"></option> }
      </datalist>
    </aside>
  `,
  styles: `
    /* Calque au-dessus de la page : le tiroir et son fond partagent un même plan (sortie animée d'un seul bloc). */
    :host { position: fixed; inset: 0; z-index: 70; }
    :host(.editor-out) { pointer-events: none; animation: editor-out .28s ease-in forwards; }
    :host(.editor-out) .drawer { animation: drawer-out .28s ease-in forwards; }
    @keyframes editor-out { to { opacity: 0; } }
    @keyframes drawer-out { to { transform: translateX(36px); } }
    .backdrop { position: fixed; inset: 0; background: rgba(5, 8, 18, .3); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); z-index: 70;
      animation: backdrop-in .3s ease backwards; }
    @keyframes backdrop-in { from { opacity: 0; } }
    .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(640px, 100%); z-index: 71; border-radius: var(--radius) 0 0 var(--radius); overflow: auto; }
    .head { position: sticky; top: 0; z-index: 2; background: var(--surface-solid); }
    .head-icon { display: grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 11px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -8px var(--accent), inset 0 1px 0 rgb(255 255 255 / .35);
      animation: icon-pop .5s var(--spring) .1s backwards; }
    @keyframes icon-pop { from { opacity: 0; transform: scale(.4) rotate(-20deg); } }
    .head-text { display: grid; min-width: 0; }
    .btn.square { width: 32px; padding: 0; justify-content: center; }
    .btn.square wl-nav-icon { transition: transform .4s var(--spring); }
    .btn.square:hover wl-nav-icon { transform: rotate(90deg); }
    /* Champs en cascade à l'ouverture (et à chaque bloc qui apparaît quand le type change). */
    .form { display: grid; gap: 14px; padding: 14px 16px; }
    .form > * { animation: field-in .45s var(--ease) backwards; }
    .form > :nth-child(2) { animation-delay: 40ms; } .form > :nth-child(3) { animation-delay: 80ms; } .form > :nth-child(4) { animation-delay: 120ms; }
    .form > :nth-child(5) { animation-delay: 160ms; } .form > :nth-child(6) { animation-delay: 200ms; } .form > :nth-child(7) { animation-delay: 240ms; }
    .form > :nth-child(8) { animation-delay: 280ms; }
    @keyframes field-in { from { opacity: 0; transform: translateY(10px); } }
    .group { display: grid; gap: 14px; }
    fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px 12px; margin: 0; display: grid; gap: 10px;
      background: color-mix(in srgb, var(--surface-2) 50%, transparent); transition: border-color .25s; }
    fieldset:focus-within { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    legend { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--text-3); text-transform: uppercase;
      letter-spacing: .06em; padding: 0 6px; transition: color .25s; }
    legend wl-nav-icon { color: var(--accent); }
    fieldset:focus-within legend { color: var(--text-2); }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label:focus-within { color: var(--accent); }
    label.inline { display: flex; align-items: center; gap: 8px; }
    .num-input { width: 70px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .three { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 10px; }
    .seg { justify-self: start; flex-wrap: wrap; }
    .seg button { display: inline-flex; align-items: center; gap: 6px; }
    .seg button wl-nav-icon { opacity: .7; transition: opacity .2s, transform .35s var(--spring); }
    .seg button.on wl-nav-icon, .seg button:hover wl-nav-icon { opacity: 1; }
    .seg button.on wl-nav-icon { transform: scale(1.12); }
    .note { display: flex; align-items: center; gap: 6px; }
    /* Valeurs proposées : pastilles en cascade, compteur, coche quand la condition est déjà dans le filtre. */
    .suggest { display: grid; gap: 8px; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 112px; overflow: auto; padding: 2px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 4px 0 7px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--surface-2); color: var(--text-2); font: 11.5px var(--mono); cursor: pointer; max-width: 260px;
      transition: border-color .2s, color .2s, background-color .2s, transform .3s var(--spring);
      animation: chip-in .35s var(--spring) backwards; animation-delay: min(calc(var(--i) * 18ms), 360ms); }
    @keyframes chip-in { from { opacity: 0; transform: scale(.8); } }
    .chip:hover { border-color: var(--accent); color: var(--text-1); transform: translateY(-1px); }
    .chip:active { transform: scale(.94); }
    .chip.on { border-color: var(--accent); color: var(--text-1); background: var(--accent-soft); }
    .chip .ellipsis { min-width: 0; }
    .chip-icon { color: var(--accent); transition: transform .35s var(--spring); }
    .chip:hover .chip-icon { transform: rotate(90deg); }
    .chip.on .chip-icon, .chip.on:hover .chip-icon { transform: none; }
    .chip-count { padding: 0 6px; border-radius: 999px; font-size: 10px; line-height: 16px; color: var(--text-3); background: var(--surface-3); }
    .chip-ghost { height: 24px; border-radius: 999px; }
    /* Aperçu : pastille « en direct » qui pulse doucement. */
    .preview { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; background: var(--code-bg); }
    .preview-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .live { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; color: var(--text-2); }
    .actions { display: flex; align-items: center; gap: 8px; position: sticky; bottom: 0; z-index: 2; background: var(--surface-solid); padding: 10px 0;
      border-top: 1px solid var(--border-soft); }
    .keys { display: inline-flex; align-items: center; gap: 6px; }
    p { margin: 0; }
    @media (max-width: 560px) { .two, .three { grid-template-columns: 1fr; } }
  `,
  host: { '(document:keydown.escape)': 'onEscape($event)' },
})
export class PanelEditor implements OnInit, OnDestroy {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);
  readonly panel = input.required<Panel>();
  readonly isNew = input(false);
  readonly save = output<Panel>();
  readonly cancel = output<void>();

  protected readonly types = PANEL_TYPES;
  protected readonly sources = SOURCES;
  protected readonly views = VIEWS;
  protected readonly aggregates = AGGREGATES;
  protected readonly formatNumber = formatNumber;
  protected readonly metrics = signal<MetricInfo[]>([]);
  protected readonly services = signal<string[]>([]);
  protected readonly fields = signal<FieldInfo[]>([]);
  protected readonly values = signal<FieldValue[]>([]);
  protected readonly loadingValues = signal(false);
  protected readonly suggestField = signal('');
  protected readonly draft = signal<Panel>(newPanel());
  /** Icône de l'en-tête : suit le type et l'affichage choisis. */
  protected readonly icon = computed(() => panelIcon(this.draft()));
  protected p!: Panel;
  protected titleTouched = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly textFields = computed(() => this.fields().filter((f) => f.kind === 'text'));
  protected readonly numberFields = computed(() => this.fields().filter((f) => f.kind === 'number'));
  protected readonly sourceHint = computed(() => SOURCES.find((s) => s.value === (this.draft().dataSource ?? 'logs'))?.hint ?? '');

  ngOnInit() {
    this.p = { outgoing: false, statusClass: null, level: null, dataSource: 'logs', aggregate: 'count', view: 'timeseries', limit: 10, ...structuredClone(this.panel()) };
    this.titleTouched = !this.isNew();
    this.draft.set(structuredClone(this.p));
    this.loadFields();
    this.api.metrics({ from: '24h', to: '' }, '').subscribe((m) => this.metrics.set(m));
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
  }

  /** Échap ferme le tiroir, sauf dans une liste déroulante ouverte (seule la liste se ferme). */
  protected onEscape(event: Event) {
    const target = event.target as HTMLElement | null;
    try {
      if (target?.matches('select:open')) return;
    } catch {
      /* pseudo-classe :open inconnue du navigateur */
    }
    this.cancel.emit();
  }

  protected needsNumber() {
    return AGGREGATES.find((a) => a.value === this.p.aggregate)?.numeric ?? false;
  }

  protected metricIcon(type: number) {
    return METRIC_ICONS[type] ?? 'metrics';
  }

  /** Met à jour l'aperçu (avec un petit délai pendant la saisie). */
  changed() {
    this.autoTitle();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.draft.set(structuredClone(this.p)), 350);
  }

  setSource(source: DataSource) {
    this.p.dataSource = source;
    this.p.field = null;
    this.p.groupBy = source === 'logs' ? 'level' : source === 'spans' ? 'name' : 'name';
    if (this.needsNumber() && source === 'spans') this.p.field = 'duration';
    if (this.needsNumber() && source === 'metrics') this.p.field = 'value';
    this.values.set([]);
    this.suggestField.set('');
    this.loadFields();
    this.changed();
  }

  setView(view: CustomView) {
    this.p.view = view;
    this.changed();
  }

  onAggregate() {
    if (this.needsNumber() && !this.numberFields().some((f) => f.key === this.p.field)) this.p.field = this.numberFields()[0]?.key ?? null;
    if (this.p.aggregate === 'distinct' && !this.p.field) this.p.field = 'service';
  }

  onType() {
    const p = this.p;
    if (p.type === 'custom') Object.assign(p, { dataSource: 'logs', aggregate: 'count', groupBy: 'level', view: 'bars', limit: 10 });
    if (p.type === 'http') Object.assign(p, { stat: 'rate', groupBy: 'route' });
    if (p.type === 'stat') Object.assign(p, { source: 'http', stat: 'rate', width: 3, height: 's' });
    if (p.type === 'metric') Object.assign(p, { stat: null, groupBy: 'service', metric: p.metric ?? this.metrics()[0]?.name ?? null });
    if (p.type === 'logs') p.height = 's';
    if (p.type === 'errors' || p.type === 'logs-table') p.width = 12;
    this.changed();
  }

  loadValues(key: string) {
    this.suggestField.set(key);
    this.values.set([]);
    if (!key) return;
    this.loadingValues.set(true);
    this.api.fieldValues(this.state.range(), this.p.dataSource ?? 'logs', key).subscribe({
      next: (v) => {
        this.values.set(v);
        this.loadingValues.set(false);
      },
      error: () => this.loadingValues.set(false),
    });
  }

  /** Condition « champ:valeur » telle qu'elle s'écrit dans le filtre. */
  private condition(value: string) {
    return `${this.suggestField()}:${/\s/.test(value) ? `"${value}"` : value}`;
  }

  protected hasCondition(value: string) {
    return (this.p.query ?? '').includes(this.condition(value));
  }

  /** Ajoute la condition au filtre ; si elle y est déjà, la retire (la pastille sert d'interrupteur). */
  addCondition(value: string) {
    const token = this.condition(value);
    const query = this.p.query?.trim() ?? '';
    this.p.query = query.includes(token)
      ? query.replace(token, '').replace(/\s{2,}/g, ' ').trim() || null
      : [query, token].filter(Boolean).join(' ');
    this.changed();
  }

  submit() {
    if (this.timer) clearTimeout(this.timer);
    this.save.emit(structuredClone(this.p));
  }

  private loadFields() {
    this.api.fields(this.state.range(), this.p.dataSource ?? 'logs').subscribe((f) => this.fields.set(f));
  }

  /** Titre proposé automatiquement tant que l'utilisateur ne l'a pas modifié. */
  private autoTitle() {
    if (this.titleTouched || this.p.type !== 'custom') return;
    const what = { logs: 'logs', spans: 'spans', metrics: 'points de métriques' }[this.p.dataSource ?? 'logs'];
    const fieldLabel = this.fields().find((f) => f.key === this.p.field)?.label.replace(/ \(.*\)$/, '').toLowerCase() ?? this.p.field;
    let title = describeAggregate(this.p.aggregate, fieldLabel);
    if (this.p.aggregate === 'count' || this.p.aggregate === 'rate') title = `${title} de ${what}`;
    const group = this.fields().find((f) => f.key === this.p.groupBy)?.label ?? this.p.groupBy;
    if (group) title += ` par ${group.toLowerCase()}`;
    if (this.p.query) title += ` (${this.p.query})`;
    this.p.title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  ngOnDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }
}
