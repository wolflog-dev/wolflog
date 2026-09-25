import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { Api, Dashboard, DashboardVariable, DataSource, FieldValue, Panel } from '../core/api';
import { isUsed, resolvePanel } from '../shared/dashboard-variables';
import { AppState, Session } from '../core/state';
import { DashboardPanel, panelAlertLink, panelDataLink } from '../shared/dashboard-panel';
import { PanelEditor, newPanel } from '../shared/panel-editor';

@Component({
  selector: 'vg-dashboard',
  imports: [RouterLink, FormsModule, CdkDropList, CdkDrag, CdkDragHandle, DashboardPanel, PanelEditor],
  template: `
    <div class="page">
      <div class="page-head">
        <a routerLink="/dashboards" class="small">Tableaux de bord</a>
        <span class="muted">/</span>
        @if (dashboard(); as d) {
          @if (editing()) {
            <input class="name" [(ngModel)]="d.name" aria-label="Nom du tableau" />
            <input class="desc" [(ngModel)]="d.description" placeholder="Description (facultative)" />
            <span class="spacer"></span>
            <button class="btn" (click)="add()">Ajouter un panneau</button>
            <button class="btn danger-text" (click)="remove()">Supprimer le tableau</button>
            <button class="btn" (click)="cancelEdit()">Annuler</button>
            <button class="btn primary" (click)="save()" [disabled]="saving()">Enregistrer</button>
          } @else {
            <h1>{{ d.name }}</h1>
            @if (d.description) { <span class="muted small">{{ d.description }}</span> }
            <span class="spacer"></span>
            @if (savedMessage()) { <span class="small ok">{{ savedMessage() }}</span> }
            @if (session.canEdit()) {
              <button class="btn" (click)="add()">Ajouter un panneau</button>
              <button class="btn" (click)="duplicateDashboard()">Dupliquer</button>
              <button class="btn" (click)="startEdit()">Réorganiser</button>
            }
          }
        }
      </div>

      @if (editing()) {
        <p class="muted small hint">Glissez les panneaux par leur poignée pour les réordonner. Les changements sont appliqués à l'enregistrement.</p>
        <section class="panel vars-editor">
          <div class="panel-head">
            <h2>Variables</h2>
            <span class="muted small">une liste de choix dans l'en-tête ; dans un panneau, écrire <code>$nom</code> (filtre, service, regroupement, titre), ex. <code>http.route:$route</code></span>
            <span class="spacer"></span>
            <button class="btn small" (click)="addVariable()">Ajouter une variable</button>
          </div>
          @for (v of dashboard()?.variables ?? []; track $index; let i = $index) {
            <div class="var-row">
              <label>Nom <input [ngModel]="v.name" (ngModelChange)="patchVariable(i, { name: $event })" placeholder="route" class="mono" /></label>
              <label>Libellé <input [ngModel]="v.label ?? ''" (ngModelChange)="patchVariable(i, { label: $event })" [placeholder]="v.name" /></label>
              <label>Valeurs de
                <select [ngModel]="v.source" (ngModelChange)="patchVariable(i, { source: $event })">
                  <option value="spans">traces</option><option value="logs">logs</option><option value="metrics">métriques</option>
                </select>
              </label>
              <label>Champ <input [ngModel]="v.field" (ngModelChange)="patchVariable(i, { field: $event })" placeholder="http.route" class="mono" [attr.list]="'fields-' + v.source" /></label>
              <span class="muted small">{{ used(v) ? 'utilisée' : 'pas encore utilisée' }}</span>
              <button class="btn ghost small" (click)="removeVariable(i)">Retirer</button>
            </div>
          } @empty {
            <p class="muted small empty-vars">Aucune variable. Exemple : « route » sur le champ http.route des traces, pour afficher les panneaux d'une seule route.</p>
          }
          @for (src of sources; track src) {
            <datalist [id]="'fields-' + src">@for (f of fieldList()[src] ?? []; track f) { <option [value]="f"></option> }</datalist>
          }
        </section>
      } @else if (dashboard()?.variables?.length) {
        <div class="vars">
          @for (v of dashboard()!.variables!; track v.name) {
            <label>{{ v.label || v.name }}
              <select [ngModel]="values()[v.name] ?? ''" (ngModelChange)="setValue(v.name, $event)">
                <option value="">Tous</option>
                @for (o of options()[v.name] ?? []; track o.value) { <option [value]="o.value">{{ o.value }}</option> }
                @if (missing(v.name); as m) { <option [value]="m">{{ m }}</option> }
              </select>
            </label>
          }
        </div>
      }

      @if (dashboard(); as d) {
        <div class="grid" cdkDropList cdkDropListOrientation="mixed" [cdkDropListDisabled]="!editing()" (cdkDropListDropped)="drop($event)">
          @for (p of d.panels; track p.id) {
            <section class="panel cell" cdkDrag [style.grid-column]="'span ' + (expanded() === p.id ? 12 : p.width)" [class.editing]="editing()">
              <div class="panel-head">
                @if (editing()) { <span class="grip" cdkDragHandle title="Déplacer">⠿</span> }
                <h2 class="ellipsis" [title]="p.title">{{ (resolved().get(p.id) ?? p).title }}</h2>
                <span class="spacer"></span>
                <div class="tools" [class.always]="editing()">
                  @if (editing()) {
                    <button class="btn ghost small" (click)="edit(p)">Configurer</button>
                    <button class="btn ghost small" (click)="duplicate(p)">Dupliquer</button>
                    <button class="btn ghost small" (click)="removePanel(p)">Retirer</button>
                  } @else {
                    @if (session.canEdit()) { <button class="btn ghost small" (click)="edit(p)">Modifier</button> }
                    <button class="btn ghost small" (click)="toggleExpand(p)">{{ expanded() === p.id ? 'Réduire' : 'Agrandir' }}</button>
                    <a class="btn ghost small" [routerLink]="link(p).path" [queryParams]="link(p).query">Voir les données</a>
                    @if (session.canEdit() && p.type !== 'logs-table' && p.type !== 'metric') {
                      <a class="btn ghost small" routerLink="/alerts" [queryParams]="alertLink(p)" title="Créer une alerte à partir de ce panneau">Alerter</a>
                    }
                  }
                </div>
              </div>
              <div class="panel-body">
                <vg-dashboard-panel [panel]="resolved().get(p.id) ?? p" [heightOverride]="expanded() === p.id ? 460 : null" />
              </div>
            </section>
          } @empty {
            <div class="panel empty whole">
              <p>Ce tableau est vide.</p>
              @if (session.canEdit()) { <button class="btn primary" (click)="add()">Ajouter un premier panneau</button> }
            </div>
          }
        </div>
      } @else if (notFound()) {
        <div class="panel empty">Tableau de bord introuvable. <a routerLink="/dashboards">Retour à la liste</a></div>
      }
    </div>

    @if (editingPanel(); as p) {
      <vg-panel-editor [panel]="p" [isNew]="isNewPanel()" (save)="applyPanel($event)" (cancel)="editingPanel.set(null)" />
    }
  `,
  styles: `
    .name { width: 240px; font-weight: 600; }
    .desc { width: 300px; }
    .danger-text { color: var(--danger); }
    .hint { margin: -6px 0 0; }
    .vars { display: flex; flex-wrap: wrap; gap: 12px; margin-top: -4px; }
    .vars label, .var-row label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
    .vars select { min-width: 180px; }
    .vars-editor .panel-head { flex-wrap: wrap; }
    .var-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border-soft); }
    .var-row input { width: 150px; }
    .empty-vars { margin: 0; padding: 10px 12px; }
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 14px; }
    .cell { min-width: 0; }
    .cell.editing { outline: 1px dashed var(--border); outline-offset: 2px; }
    .grip { cursor: grab; color: var(--text-3); user-select: none; }
    /* Outils en surimpression au survol : ils ne prennent jamais la place du titre. */
    .cell .panel-head { position: relative; }
    .tools { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; padding-left: 12px;
      background: linear-gradient(to right, transparent, var(--surface) 12px); opacity: 0; pointer-events: none; transition: opacity .12s; }
    .cell:hover .tools, .cell:focus-within .tools, .tools.always { opacity: 1; pointer-events: auto; }
    .panel-body { padding: 8px 10px; }
    .btn.small { height: 24px; font-size: 12px; padding: 0 8px; }
    .whole { grid-column: span 12; display: grid; justify-items: center; gap: 10px; }
    .whole p { margin: 0; }
    .cdk-drag-preview { opacity: .85; }
    .cdk-drag-placeholder { opacity: .3; }
    @media (hover: none) { .tools { opacity: 1; pointer-events: auto; position: static; transform: none; background: none; } }
    @media (max-width: 900px) { .cell { grid-column: span 12 !important; } }
  `,
  host: { '(document:keydown.escape)': 'expanded.set(null)' },
})
export class DashboardPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);
  readonly id = input.required<string>();
  /** ?edit=1 : ouvre directement en édition (nouveau tableau). */
  readonly edit$ = input<string | null>(null, { alias: 'edit' });

  protected readonly dashboard = signal<Dashboard | null>(null);
  protected readonly editing = signal(false);
  protected readonly editingPanel = signal<Panel | null>(null);
  protected readonly isNewPanel = signal(false);
  protected readonly expanded = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly notFound = signal(false);
  protected readonly savedMessage = signal('');
  protected readonly link = panelDataLink;
  protected readonly alertLink = panelAlertLink;
  private backup: Dashboard | null = null;
  private readonly state = inject(AppState);
  protected readonly sources: DataSource[] = ['spans', 'logs', 'metrics'];

  /** Valeurs choisies pour les variables (aussi dans l'adresse : var-nom=valeur, lien partageable). */
  protected readonly values = signal<Record<string, string>>({});
  protected readonly options = signal<Record<string, FieldValue[]>>({});
  protected readonly fieldList = signal<Record<string, string[]>>({});
  /** Panneaux avec les variables remplacées (même objet tant que rien ne change : pas de rechargement inutile). */
  protected readonly resolved = computed(() => {
    const d = this.dashboard();
    const map = new Map<string, Panel>();
    if (!d) return map;
    for (const p of d.panels) map.set(p.id, resolvePanel(p, d.variables ?? [], this.values()));
    return map;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() =>
        this.api.dashboard(id).subscribe({
          next: (d) => {
            this.dashboard.set(d);
            this.notFound.set(false);
            this.initValues(d);
            if (this.edit$() && !d.panels.length) this.add();
          },
          error: () => this.notFound.set(true),
        }),
      );
    });
  }

  private initValues(d: Dashboard) {
    const url = new URLSearchParams(location.search);
    const values: Record<string, string> = {};
    for (const v of d.variables ?? []) values[v.name] = url.get('var-' + v.name) ?? v.default ?? '';
    this.values.set(values);
    this.loadOptions();
  }

  /** Valeurs proposées : les plus fréquentes sur la période affichée. */
  private loadOptions() {
    for (const v of this.dashboard()?.variables ?? []) {
      if (!v.name || !v.field) continue;
      this.api.fieldValues(this.state.range(), v.source, v.field).subscribe({
        next: (list) => this.options.update((o) => ({ ...o, [v.name]: list })),
        error: () => {},
      });
    }
  }

  /** Valeur choisie (lien partagé) absente des valeurs récentes : on la garde dans la liste. */
  protected missing(name: string) {
    const value = this.values()[name];
    return value && !(this.options()[name] ?? []).some((o) => o.value === value) ? value : null;
  }

  protected setValue(name: string, value: string) {
    this.values.update((v) => ({ ...v, [name]: value }));
    this.router.navigate([], { queryParams: { ['var-' + name]: value || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected used(v: DashboardVariable) {
    return isUsed(v, this.dashboard()?.panels ?? []);
  }

  protected addVariable() {
    const d = this.dashboard();
    if (!d) return;
    this.dashboard.set({ ...d, variables: [...(d.variables ?? []), { name: 'route', label: 'Route', field: 'http.route', source: 'spans' }] });
    for (const src of this.sources) {
      if (this.fieldList()[src]) continue;
      this.api.fields(this.state.range(), src).subscribe((f) => this.fieldList.update((l) => ({ ...l, [src]: f.map((x) => x.key) })));
    }
  }

  protected patchVariable(i: number, change: Partial<DashboardVariable>) {
    const d = this.dashboard();
    if (!d?.variables) return;
    this.dashboard.set({ ...d, variables: d.variables.map((v, j) => (j === i ? { ...v, ...change } : v)) });
  }

  protected removeVariable(i: number) {
    const d = this.dashboard();
    if (!d?.variables) return;
    this.dashboard.set({ ...d, variables: d.variables.filter((_, j) => j !== i) });
  }

  startEdit() {
    this.backup = structuredClone(this.dashboard());
    this.editing.set(true);
  }

  cancelEdit() {
    this.dashboard.set(this.backup);
    this.editing.set(false);
  }

  save() {
    this.persist(() => this.editing.set(false));
  }

  remove() {
    const d = this.dashboard();
    if (!d || !confirm(`Supprimer le tableau « ${d.name} » ? Cette action est définitive.`)) return;
    this.api.deleteDashboard(d.id).subscribe(() => this.router.navigate(['/dashboards']));
  }

  duplicateDashboard() {
    const d = this.dashboard();
    if (!d) return;
    const copy = { ...structuredClone(d), name: `${d.name} (copie)`, panels: d.panels.map((p) => ({ ...p, id: newPanel().id })) };
    this.api.createDashboard(copy).subscribe((created) => this.router.navigate(['/dashboards', created.id]));
  }

  drop(event: CdkDragDrop<Panel[]>) {
    this.update((panels) => moveItemInArray(panels, event.previousIndex, event.currentIndex));
  }

  add() {
    this.isNewPanel.set(true);
    this.editingPanel.set(newPanel());
  }

  edit(p: Panel) {
    this.isNewPanel.set(false);
    this.editingPanel.set(p);
  }

  toggleExpand(p: Panel) {
    this.expanded.set(this.expanded() === p.id ? null : p.id);
  }

  duplicate(p: Panel) {
    this.update((panels) => panels.splice(panels.indexOf(p) + 1, 0, { ...structuredClone(p), id: newPanel().id, title: p.title + ' (copie)' }));
  }

  removePanel(p: Panel) {
    this.update((panels) => panels.splice(panels.indexOf(p), 1));
  }

  applyPanel(p: Panel) {
    this.update((panels) => {
      const i = panels.findIndex((x) => x.id === p.id);
      if (i >= 0) panels[i] = p;
      else panels.push(p);
    });
    this.editingPanel.set(null);
    // Hors mode réorganisation, chaque modification de panneau est enregistrée immédiatement.
    if (!this.editing()) this.persist(() => this.flash('Enregistré'));
  }

  private persist(done: () => void) {
    const d = this.dashboard();
    if (!d) return;
    this.saving.set(true);
    this.api.saveDashboard(d).subscribe({
      next: (saved) => {
        this.dashboard.set(saved);
        this.saving.set(false);
        this.initValues(saved);
        this.router.navigate([], { queryParams: { edit: null }, replaceUrl: true });
        done();
      },
      error: () => {
        this.saving.set(false);
        this.flash('Échec de l’enregistrement');
      },
    });
  }

  private flash(message: string) {
    this.savedMessage.set(message);
    setTimeout(() => this.savedMessage.set(''), 2500);
  }

  /** Modifie la liste de panneaux et publie un nouvel objet (les panneaux se rechargent). */
  private update(change: (panels: Panel[]) => void) {
    const d = this.dashboard();
    if (!d) return;
    const panels = [...d.panels];
    change(panels);
    this.dashboard.set({ ...d, panels });
  }
}
