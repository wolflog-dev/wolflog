import { Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, CustomView, DataSource, FieldInfo, FieldValue, MetricInfo, Panel, PanelType } from '../core/api';
import { AppState } from '../core/state';
import { formatNumber } from '../core/format';
import { AGGREGATES, DashboardPanel, describeAggregate } from './dashboard-panel';

export const PANEL_TYPES: { value: PanelType; label: string }[] = [
  { value: 'custom', label: 'Requête personnalisée (à partir des données)' },
  { value: 'http', label: 'Requêtes HTTP : courbe par route / statut' },
  { value: 'stat', label: 'Chiffre clé (HTTP, logs, erreurs)' },
  { value: 'metric', label: 'Métrique OpenTelemetry' },
  { value: 'logs', label: 'Logs : histogramme par niveau' },
  { value: 'logs-table', label: 'Logs : derniers messages' },
  { value: 'errors', label: 'Erreurs regroupées' },
];

const SOURCES: { value: DataSource; label: string; hint: string }[] = [
  { value: 'logs', label: 'Logs', hint: 'ex. level:warn http.route:/api/* timeout' },
  { value: 'spans', label: 'Traces', hint: 'ex. kind:serveur http.response.status_code:500 GET' },
  { value: 'metrics', label: 'Métriques', hint: 'ex. name:http.server.request.duration' },
];

const VIEWS: { value: CustomView; label: string }[] = [
  { value: 'timeseries', label: 'Courbe' },
  { value: 'bars', label: 'Barres' },
  { value: 'top', label: 'Classement' },
  { value: 'table', label: 'Tableau' },
  { value: 'stat', label: 'Chiffre' },
];

export function newPanel(): Panel {
  return {
    id: Math.random().toString(36).slice(2, 10), title: 'Nombre de logs par niveau', type: 'custom', width: 6, height: 'm',
    dataSource: 'logs', aggregate: 'count', groupBy: 'level', view: 'bars', limit: 10, outgoing: false, statusClass: null, level: null, source: 'http',
  };
}

/** Formulaire d'un panneau avec aperçu en direct. Travaille sur une copie : rien n'est modifié avant "Appliquer". */
@Component({
  selector: 'wl-panel-editor',
  imports: [FormsModule, DashboardPanel],
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <aside class="drawer panel">
      <div class="panel-head">
        <h2>{{ isNew() ? 'Nouveau panneau' : 'Configurer le panneau' }}</h2>
        <span class="spacer"></span>
        <button class="btn ghost" (click)="cancel.emit()">Fermer</button>
      </div>

      <form class="form" (ngSubmit)="submit()" (input)="changed()" (change)="changed()">
        <label>Type de panneau
          <select name="type" [(ngModel)]="p.type" (ngModelChange)="onType()">
            @for (t of types; track t.value) { <option [value]="t.value">{{ t.label }}</option> }
          </select>
        </label>

        @if (p.type === 'custom') {
          <fieldset>
            <legend>Données</legend>
            <div class="seg">
              @for (s of sources; track s.value) {
                <button type="button" [class.on]="p.dataSource === s.value" (click)="setSource(s.value)">{{ s.label }}</button>
              }
            </div>
            <label>Filtre <span class="muted">(même syntaxe que la recherche, vide = tout)</span>
              <input name="filter" class="mono" [(ngModel)]="p.query" [placeholder]="sourceHint()" />
            </label>
            <div class="suggest">
              <select name="suggestField" [ngModel]="suggestField()" (ngModelChange)="loadValues($event)">
                <option value="">Ajouter une condition sur…</option>
                @for (f of textFields(); track f.key) { <option [value]="f.key">{{ f.label }}</option> }
              </select>
              @if (values().length) {
                <div class="chips">
                  @for (v of values(); track v.value) {
                    <button type="button" class="chip" (click)="addCondition(v.value)" [title]="formatNumber(v.count) + ' élément(s)'">{{ v.value }}</button>
                  }
                </div>
              }
            </div>
          </fieldset>

          <fieldset>
            <legend>Calcul</legend>
            <div class="two">
              <label>Mesure
                <select name="agg" [(ngModel)]="p.aggregate" (ngModelChange)="onAggregate()">
                  @for (a of aggregates; track a.value) { <option [value]="a.value">{{ a.label }}</option> }
                </select>
              </label>
              @if (needsNumber()) {
                <label>Champ numérique
                  <select name="field" [(ngModel)]="p.field">
                    @for (f of numberFields(); track f.key) { <option [value]="f.key">{{ f.label }}</option> }
                  </select>
                </label>
              } @else if (p.aggregate === 'distinct') {
                <label>Champ
                  <select name="field" [(ngModel)]="p.field">
                    @for (f of textFields(); track f.key) { <option [value]="f.key">{{ f.label }}</option> }
                  </select>
                </label>
              }
            </div>
            @if (needsNumber() && !numberFields().length) {
              <p class="muted small">Aucun champ numérique trouvé dans ces données sur la période.</p>
            }
            <label>Grouper par
              <select name="groupBy" [(ngModel)]="p.groupBy">
                <option [ngValue]="null">Aucun regroupement</option>
                @for (f of textFields(); track f.key) { <option [value]="f.key">{{ f.label }}{{ f.builtin ? '' : '  (' + formatNumber(f.seen) + ')' }}</option> }
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend>Affichage</legend>
            <div class="seg">
              @for (v of views; track v.value) {
                <button type="button" [class.on]="p.view === v.value" (click)="setView(v.value)">{{ v.label }}</button>
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
              <option value="http">Requêtes HTTP</option><option value="logs">Nombre de logs</option><option value="errors">Nombre d'exceptions</option>
            </select>
          </label>
        }

        @if (p.type === 'http' || (p.type === 'stat' && (p.source ?? 'http') === 'http')) {
          <div class="two">
            <label>Sens
              <select name="outgoing" [(ngModel)]="p.outgoing">
                <option [ngValue]="false">Reçues (serveur)</option><option [ngValue]="true">Sortantes (HttpClient)</option>
              </select>
            </label>
            <label>Mesure
              <select name="stat" [(ngModel)]="p.stat">
                <option value="rate">Débit (req/s)</option>
                @if (p.type === 'stat') { <option value="count">Nombre de requêtes</option> }
                @if (p.type === 'http') { <option value="errors">Erreurs (req/s)</option> }
                <option value="errorRate">Taux d'erreur (%)</option>
                <option value="p50">Latence p50</option><option value="p95">Latence p95</option><option value="p99">Latence p99</option>
                @if (p.type === 'http') { <option value="avg">Latence moyenne</option> }
              </select>
            </label>
          </div>
          @if (p.type === 'http') {
            <label>Grouper par
              <select name="groupByHttp" [(ngModel)]="p.groupBy">
                <option value="route">{{ p.outgoing ? 'Hôte appelé' : 'Route' }}</option><option value="status">Code HTTP</option>
                <option value="method">Méthode</option><option value="service">Service</option><option value="none">Aucun (total)</option>
              </select>
            </label>
          }
          <div class="two">
            <label>Filtre route / URL <input name="query" [(ngModel)]="p.query" placeholder="ex. /api/orders" /></label>
            <label>Statut
              <select name="statusClass" [(ngModel)]="p.statusClass">
                <option [ngValue]="null">Tous</option><option value="2xx">2xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option><option value="errors">En erreur</option>
              </select>
            </label>
          </div>
        }

        @if (p.type === 'metric') {
          <label>Métrique
            <select name="metric" [(ngModel)]="p.metric">
              @for (m of metrics(); track m.name) { <option [value]="m.name">{{ m.name }}</option> }
            </select>
          </label>
          <div class="two">
            <label>Statistique <span class="muted">(histogrammes)</span>
              <select name="mstat" [(ngModel)]="p.stat">
                <option [ngValue]="null">Par défaut</option><option value="p50">p50</option><option value="p95">p95</option><option value="p99">p99</option>
                <option value="avg">Moyenne</option><option value="max">Max</option><option value="count">Nombre / s</option>
              </select>
            </label>
            <label>Grouper par <input name="mgroup" [(ngModel)]="p.groupBy" placeholder="service, none, http.route…" /></label>
          </div>
        }

        @if (p.type === 'logs' || p.type === 'logs-table' || p.type === 'errors' || (p.type === 'stat' && (p.source === 'logs' || p.source === 'errors'))) {
          <label>Recherche <input name="lq" [(ngModel)]="p.query" class="mono" placeholder='ex. paiement http.route:/pay/* "délai dépassé"' /></label>
          @if (p.type !== 'errors' && p.source !== 'errors') {
            <label>Niveau minimum
              <select name="level" [(ngModel)]="p.level">
                <option [ngValue]="null">Tous</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option><option value="fatal">Fatal</option>
              </select>
            </label>
          }
        }

        <fieldset>
          <legend>Présentation</legend>
          <label>Titre <input name="title" [(ngModel)]="p.title" (input)="titleTouched = true" required /></label>
          <div class="three">
            <label>Largeur
              <select name="width" [(ngModel)]="p.width">
                <option [ngValue]="3">1/4</option><option [ngValue]="4">1/3</option><option [ngValue]="6">1/2</option>
                <option [ngValue]="8">2/3</option><option [ngValue]="12">Pleine largeur</option>
              </select>
            </label>
            <label>Hauteur
              <select name="height" [(ngModel)]="p.height">
                <option value="s">Petite</option><option value="m">Moyenne</option><option value="l">Grande</option>
              </select>
            </label>
            <label>Service
              <input name="service" [(ngModel)]="p.service" list="wl-services" placeholder="filtre global" />
            </label>
          </div>
        </fieldset>

        <div class="preview">
          <div class="preview-head small muted">Aperçu : {{ state.label().toLowerCase() }}</div>
          <wl-dashboard-panel [panel]="draft()" [heightOverride]="180" />
        </div>

        <div class="actions">
          <button class="btn primary" type="submit">{{ isNew() ? 'Ajouter au tableau' : 'Appliquer' }}</button>
          <button class="btn" type="button" (click)="cancel.emit()">Annuler</button>
        </div>
      </form>
      <datalist id="wl-services">
        @for (s of services(); track s) { <option [value]="s"></option> }
      </datalist>
    </aside>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 70; }
    .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(640px, 100%); z-index: 71; border-radius: 0; overflow: auto; }
    .form { display: grid; gap: 14px; padding: 14px; }
    fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px 12px; margin: 0; display: grid; gap: 10px; }
    legend { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: .05em; padding: 0 4px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.inline { display: flex; align-items: center; gap: 8px; }
    .num-input { width: 70px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .three { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 10px; }
    .suggest { display: grid; gap: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 96px; overflow: auto; }
    .chip { height: 22px; padding: 0 8px; border-radius: 3px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
      font: 11.5px var(--mono); cursor: pointer; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip:hover { border-color: var(--accent); color: var(--text-1); }
    .preview { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; background: var(--bg); }
    .preview-head { margin-bottom: 6px; }
    .actions { display: flex; gap: 8px; position: sticky; bottom: 0; background: var(--surface); padding: 8px 0; }
    p { margin: 0; }
  `,
  host: { '(document:keydown.escape)': 'cancel.emit()' },
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
  protected readonly suggestField = signal('');
  protected readonly draft = signal<Panel>(newPanel());
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

  protected needsNumber() {
    return AGGREGATES.find((a) => a.value === this.p.aggregate)?.numeric ?? false;
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
    this.api.fieldValues(this.state.range(), this.p.dataSource ?? 'logs', key).subscribe((v) => this.values.set(v));
  }

  addCondition(value: string) {
    const key = this.suggestField();
    const token = `${key}:${/\s/.test(value) ? `"${value}"` : value}`;
    this.p.query = [this.p.query?.trim(), token].filter(Boolean).join(' ');
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
