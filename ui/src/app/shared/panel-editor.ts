import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, MetricInfo, Panel, PanelType } from '../core/api';
import { AppState } from '../core/state';

export const PANEL_TYPES: { value: PanelType; label: string }[] = [
  { value: 'http', label: 'Requêtes HTTP (courbe)' },
  { value: 'stat', label: 'Chiffre clé' },
  { value: 'metric', label: 'Métrique' },
  { value: 'logs', label: 'Logs (histogramme)' },
  { value: 'logs-table', label: 'Logs (liste)' },
  { value: 'errors', label: 'Erreurs regroupées' },
];

export function newPanel(): Panel {
  return { id: Math.random().toString(36).slice(2, 10), title: 'Nouveau panneau', type: 'http', width: 6, height: 'm', stat: 'rate', groupBy: 'route', outgoing: false, statusClass: null, level: null, source: 'http' };
}

/** Formulaire d'un panneau (tiroir latéral). Travaille sur une copie : rien n'est modifié avant "Appliquer". */
@Component({
  selector: 'vg-panel-editor',
  imports: [FormsModule],
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <aside class="drawer panel">
      <div class="panel-head"><h2>Panneau</h2><span class="spacer"></span><button class="btn ghost" (click)="cancel.emit()">Fermer</button></div>
      <form class="form" (ngSubmit)="save.emit(p)">
        <label>Titre <input name="title" [(ngModel)]="p.title" required /></label>
        <label>Type
          <select name="type" [(ngModel)]="p.type" (ngModelChange)="onType()">
            @for (t of types; track t.value) { <option [value]="t.value">{{ t.label }}</option> }
          </select>
        </label>
        <div class="two">
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
        </div>
        <label>Service <span class="muted">(vide = filtre global)</span>
          <input name="service" [(ngModel)]="p.service" list="vg-services" placeholder="tous" />
        </label>

        @if (p.type === 'stat') {
          <label>Source
            <select name="source" [(ngModel)]="p.source">
              <option value="http">Requêtes HTTP</option><option value="logs">Nombre de logs</option><option value="errors">Nombre d'exceptions</option>
            </select>
          </label>
        }

        @if (p.type === 'http' || (p.type === 'stat' && (p.source ?? 'http') === 'http')) {
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
          @if (p.type === 'http') {
            <label>Grouper par
              <select name="groupBy" [(ngModel)]="p.groupBy">
                <option value="route">{{ p.outgoing ? 'Hôte appelé' : 'Route' }}</option><option value="status">Code HTTP</option>
                <option value="method">Méthode</option><option value="service">Service</option><option value="none">Aucun (total)</option>
              </select>
            </label>
          }
          <label>Filtre route / URL <input name="query" [(ngModel)]="p.query" placeholder="ex. /api/orders" /></label>
          <label>Statut
            <select name="statusClass" [(ngModel)]="p.statusClass">
              <option [ngValue]="null">Tous</option><option value="2xx">2xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option><option value="errors">En erreur</option>
            </select>
          </label>
        }

        @if (p.type === 'metric') {
          <label>Métrique
            <select name="metric" [(ngModel)]="p.metric">
              @for (m of metrics(); track m.name) { <option [value]="m.name">{{ m.name }}</option> }
            </select>
          </label>
          <label>Statistique <span class="muted">(histogrammes)</span>
            <select name="mstat" [(ngModel)]="p.stat">
              <option [ngValue]="null">Par défaut</option><option value="p50">p50</option><option value="p95">p95</option><option value="p99">p99</option>
              <option value="avg">Moyenne</option><option value="max">Max</option><option value="count">Nombre / s</option>
            </select>
          </label>
          <label>Grouper par <input name="mgroup" [(ngModel)]="p.groupBy" placeholder="service, none, ou un attribut (http.route…)" /></label>
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

        <div class="actions">
          <button class="btn primary" type="submit">Appliquer</button>
          <button class="btn" type="button" (click)="cancel.emit()">Annuler</button>
        </div>
      </form>
      <datalist id="vg-services">
        @for (s of services(); track s) { <option [value]="s"></option> }
      </datalist>
    </aside>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 70; }
    .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100%); z-index: 71; border-radius: 0; overflow: auto; }
    .form { display: grid; gap: 12px; padding: 14px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .actions { display: flex; gap: 8px; margin-top: 6px; }
  `,
})
export class PanelEditor implements OnInit {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  readonly panel = input.required<Panel>();
  readonly save = output<Panel>();
  readonly cancel = output<void>();

  protected readonly types = PANEL_TYPES;
  protected readonly metrics = signal<MetricInfo[]>([]);
  protected readonly services = signal<string[]>([]);
  protected p!: Panel;

  ngOnInit() {
    this.p = { outgoing: false, statusClass: null, level: null, ...structuredClone(this.panel()) };
    this.api.metrics({ from: '24h', to: '' }, '').subscribe((m) => this.metrics.set(m));
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
  }

  onType() {
    // Valeurs par défaut sensées pour le nouveau type.
    const p = this.p;
    if (p.type === 'http') { p.stat = 'rate'; p.groupBy = 'route'; }
    if (p.type === 'stat') { p.source = 'http'; p.stat = 'rate'; p.width = 3; p.height = 's'; }
    if (p.type === 'metric') { p.stat = null; p.groupBy = 'service'; p.metric ??= this.metrics()[0]?.name ?? null; }
    if (p.type === 'logs') { p.height = 's'; }
  }
}
