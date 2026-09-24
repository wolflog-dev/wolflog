import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { Api, Dashboard, Panel } from '../core/api';
import { DashboardPanel } from '../shared/dashboard-panel';
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
            <input class="name" [(ngModel)]="d.name" />
            <input class="desc" [(ngModel)]="d.description" placeholder="Description" />
            <span class="spacer"></span>
            <button class="btn" (click)="add()">Ajouter un panneau</button>
            <button class="btn danger-text" (click)="remove()">Supprimer le tableau</button>
            <button class="btn" (click)="cancelEdit()">Annuler</button>
            <button class="btn primary" (click)="save()" [disabled]="saving()">Enregistrer</button>
          } @else {
            <h1>{{ d.name }}</h1>
            @if (d.description) { <span class="muted small">{{ d.description }}</span> }
            <span class="spacer"></span>
            <button class="btn" (click)="startEdit()">Modifier</button>
          }
        }
      </div>

      @if (dashboard(); as d) {
        <div class="grid" cdkDropList cdkDropListOrientation="mixed" [cdkDropListDisabled]="!editing()" (cdkDropListDropped)="drop($event)">
          @for (p of d.panels; track p.id) {
            <section class="panel cell" cdkDrag [style.grid-column]="'span ' + p.width" [class.editing]="editing()">
              <div class="panel-head">
                @if (editing()) { <span class="grip" cdkDragHandle title="Déplacer">⠿</span> }
                <h2 class="ellipsis">{{ p.title }}</h2>
                <span class="spacer"></span>
                @if (editing()) {
                  <button class="btn ghost small" (click)="edit(p)">Configurer</button>
                  <button class="btn ghost small" (click)="duplicate(p)">Dupliquer</button>
                  <button class="btn ghost small" (click)="removePanel(p)">Retirer</button>
                }
              </div>
              <div class="panel-body">
                <vg-dashboard-panel [panel]="p" />
              </div>
            </section>
          } @empty {
            <div class="panel empty whole">
              Ce tableau est vide. @if (!editing()) { <a (click)="startEdit()">Le modifier</a> } @else { <a (click)="add()">Ajouter un panneau</a> }
            </div>
          }
        </div>
      } @else if (notFound()) {
        <div class="panel empty">Tableau de bord introuvable.</div>
      }
    </div>

    @if (editingPanel(); as p) {
      <vg-panel-editor [panel]="p" (save)="applyPanel($event)" (cancel)="editingPanel.set(null)" />
    }
  `,
  styles: `
    .name { width: 240px; font-weight: 600; }
    .desc { width: 300px; }
    .danger-text { color: var(--danger); }
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 14px; }
    .cell { min-width: 0; }
    .cell.editing { outline: 1px dashed var(--border); outline-offset: 2px; }
    .grip { cursor: grab; color: var(--text-3); user-select: none; }
    .panel-body { padding: 8px 10px; }
    .btn.small { height: 24px; font-size: 12px; padding: 0 8px; }
    .whole { grid-column: span 12; }
    .whole a { cursor: pointer; }
    .cdk-drag-preview { opacity: .85; }
    .cdk-drag-placeholder { opacity: .3; }
    @media (max-width: 900px) { .cell { grid-column: span 12 !important; } }
  `,
})
export class DashboardPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly id = input.required<string>();
  /** ?edit=1 : ouvre directement en édition (nouveau tableau). */
  readonly edit$ = input<string | null>(null, { alias: 'edit' });

  protected readonly dashboard = signal<Dashboard | null>(null);
  protected readonly editing = signal(false);
  protected readonly editingPanel = signal<Panel | null>(null);
  protected readonly saving = signal(false);
  protected readonly notFound = signal(false);
  private backup: Dashboard | null = null;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() =>
        this.api.dashboard(id).subscribe({
          next: (d) => {
            this.dashboard.set(d);
            if (this.edit$()) this.startEdit();
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
    const d = this.dashboard();
    if (!d) return;
    this.saving.set(true);
    this.api.saveDashboard(d).subscribe({
      next: (saved) => {
        this.dashboard.set(saved);
        this.editing.set(false);
        this.saving.set(false);
        this.router.navigate([], { queryParams: { edit: null }, replaceUrl: true });
      },
      error: () => this.saving.set(false),
    });
  }

  remove() {
    const d = this.dashboard();
    if (!d || !confirm(`Supprimer le tableau « ${d.name} » ?`)) return;
    this.api.deleteDashboard(d.id).subscribe(() => this.router.navigate(['/dashboards']));
  }

  drop(event: CdkDragDrop<Panel[]>) {
    this.update((panels) => moveItemInArray(panels, event.previousIndex, event.currentIndex));
  }

  add() {
    this.editingPanel.set(newPanel());
  }

  edit(p: Panel) {
    this.editingPanel.set(p);
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
