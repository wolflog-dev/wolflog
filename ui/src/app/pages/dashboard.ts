import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { Api, Dashboard, Panel } from '../core/api';
import { Session } from '../core/state';
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
      }

      @if (dashboard(); as d) {
        <div class="grid" cdkDropList cdkDropListOrientation="mixed" [cdkDropListDisabled]="!editing()" (cdkDropListDropped)="drop($event)">
          @for (p of d.panels; track p.id) {
            <section class="panel cell" cdkDrag [style.grid-column]="'span ' + (expanded() === p.id ? 12 : p.width)" [class.editing]="editing()">
              <div class="panel-head">
                @if (editing()) { <span class="grip" cdkDragHandle title="Déplacer">⠿</span> }
                <h2 class="ellipsis" [title]="p.title">{{ p.title }}</h2>
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
                <vg-dashboard-panel [panel]="p" [heightOverride]="expanded() === p.id ? 460 : null" />
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
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 14px; }
    .cell { min-width: 0; }
    .cell.editing { outline: 1px dashed var(--border); outline-offset: 2px; }
    .grip { cursor: grab; color: var(--text-3); user-select: none; }
    .tools { display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
    .cell:hover .tools, .cell:focus-within .tools, .tools.always { opacity: 1; }
    .panel-body { padding: 8px 10px; }
    .btn.small { height: 24px; font-size: 12px; padding: 0 8px; }
    .whole { grid-column: span 12; display: grid; justify-items: center; gap: 10px; }
    .whole p { margin: 0; }
    .cdk-drag-preview { opacity: .85; }
    .cdk-drag-placeholder { opacity: .3; }
    @media (hover: none) { .tools { opacity: 1; } }
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

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() =>
        this.api.dashboard(id).subscribe({
          next: (d) => {
            this.dashboard.set(d);
            this.notFound.set(false);
            if (this.edit$() && !d.panels.length) this.add();
          },
          error: () => this.notFound.set(true),
        }),
      );
    });
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
