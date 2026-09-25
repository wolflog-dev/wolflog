import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { switchMap } from 'rxjs';
import { Api, DashboardInfo, Panel } from '../core/api';

/** Bouton qui transforme la vue courante (recherche, métrique…) en panneau de tableau de bord. */
@Component({
  selector: 'wl-add-to-dashboard',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="wrap">
      <button class="btn" type="button" (click)="toggle()" [class.on]="open()">Ajouter au tableau de bord</button>
      @if (open()) {
        <div class="menu" (click)="$event.stopPropagation()" (keydown.enter)="$event.preventDefault(); canAdd() && add()">
          @if (addedTo(); as target) {
            <p class="ok small">Panneau ajouté à « {{ target.name }} ».</p>
            <div class="row">
              <a class="btn primary" [routerLink]="['/dashboards', target.id]">Ouvrir le tableau</a>
              <button class="btn" type="button" (click)="close()">Fermer</button>
            </div>
          } @else {
            <label>Tableau
              <select [(ngModel)]="target" [ngModelOptions]="{ standalone: true }">
                @for (d of dashboards(); track d.id) { <option [value]="d.id">{{ d.name }}</option> }
                <option value="__new">Nouveau tableau…</option>
              </select>
            </label>
            @if (target === '__new') {
              <label>Nom du nouveau tableau <input [(ngModel)]="newName" [ngModelOptions]="{ standalone: true }" /></label>
            }
            <label>Titre du panneau <input [(ngModel)]="title" [ngModelOptions]="{ standalone: true }" /></label>
            @if (error()) { <p class="danger small">{{ error() }}</p> }
            <div class="row">
              <button class="btn primary" type="button" (click)="add()" [disabled]="!canAdd()">Ajouter</button>
              <button class="btn" type="button" (click)="close()">Annuler</button>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .wrap { position: relative; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 60; width: 300px; display: grid; gap: 10px; padding: 12px;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0, 0, 0, .35); }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    .row { display: flex; gap: 8px; }
    p { margin: 0; }
  `,
  host: { '(document:click)': 'close()', '(click)': '$event.stopPropagation()', '(document:keydown.escape)': 'close()' },
})
export class AddToDashboard {
  private readonly api = inject(Api);
  /** Panneau à ajouter, construit par la page à partir de ce qui est affiché. */
  readonly panel = input.required<Panel>();

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly dashboards = signal<DashboardInfo[]>([]);
  protected readonly addedTo = signal<{ id: string; name: string } | null>(null);
  protected target = '';
  protected newName = '';
  protected title = '';

  protected canAdd() {
    return !this.busy() && !!this.title.trim() && (this.target !== '__new' || !!this.newName.trim());
  }

  toggle() {
    if (this.open()) return this.close();
    this.addedTo.set(null);
    this.error.set('');
    this.title = this.panel().title;
    this.api.dashboards().subscribe((d) => {
      this.dashboards.set(d);
      this.target = d[0]?.id ?? '__new';
    });
    this.open.set(true);
  }

  close() {
    this.open.set(false);
  }

  add() {
    this.busy.set(true);
    const panel: Panel = { ...structuredClone(this.panel()), title: this.title.trim(), id: Math.random().toString(36).slice(2, 10) };
    const save$ =
      this.target === '__new'
        ? this.api.createDashboard({ name: this.newName.trim(), panels: [panel] })
        : this.api.dashboard(this.target).pipe(switchMap((d) => this.api.saveDashboard({ ...d, panels: [...d.panels, panel] })));
    save$.subscribe({
      next: (d) => {
        this.busy.set(false);
        this.addedTo.set({ id: d.id, name: d.name });
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Impossible d’enregistrer le tableau.');
      },
    });
  }
}
