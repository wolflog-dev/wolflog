import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { DashboardInfo } from '../core/models';

/** Nouveau tableau de bord : nom, description, départ vide ou copie d'un tableau existant. */
@Component({
  selector: 'wl-dashboard-form',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/dashboards" class="small">Tableaux de bord</a>
        <span class="muted">/</span>
        <h1>Nouveau tableau de bord</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/dashboards">Annuler</a>
        <button class="btn primary" (click)="create()" [disabled]="busy() || !name().trim()">Créer le tableau</button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Point de départ</h2></div>
            <div class="step-body">
              <div class="choices">
                <button type="button" class="choice" [class.on]="!from()" (click)="pick(null)">
                  <strong>Tableau vide</strong><span>Vous ajoutez les panneaux un par un.</span>
                </button>
                @for (d of existing(); track d.id) {
                  <button type="button" class="choice" [class.on]="from()?.id === d.id" (click)="pick(d)">
                    <strong>Copie de « {{ d.name }} »</strong><span>{{ d.panels }} panneau{{ d.panels > 1 ? 'x' : '' }}{{ d.description ? ' · ' + d.description : '' }}</span>
                  </button>
                }
              </div>
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">2</span><h2>Nom et description</h2></div>
            <div class="step-body">
              <label class="field">Nom <input [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="ex. Paiements" autocomplete="off" (keydown.enter)="create()" /></label>
              <label class="field">Description <input [(ngModel)]="description" placeholder="facultatif : à quoi sert ce tableau" autocomplete="off" /></label>
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <p class="phrase">{{ summary() }}</p>
            <p class="muted small">Le tableau s'ouvre en mode édition : « Ajouter un panneau » propose des requêtes toutes prêtes.</p>
          </div>
          @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="create()" [disabled]="busy() || !name().trim()">Créer le tableau</button>
            <a class="btn" routerLink="/dashboards">Annuler</a>
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .phrase { font-size: 13.5px; line-height: 1.5; }
    p { margin: 0; }
  `,
})
export class DashboardFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  /** ?from=<id> : préselectionne la copie d'un tableau (bouton « Dupliquer »). */
  readonly copy = input<string>('', { alias: 'from' });

  protected readonly existing = signal<DashboardInfo[]>([]);
  protected readonly from = signal<DashboardInfo | null>(null);
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected description = '';

  protected readonly summary = computed(() => {
    const n = this.name().trim() || 'Sans nom';
    const f = this.from();
    return f
      ? `« ${n} », copie des ${f.panels} panneaux de « ${f.name} » ; l'original reste inchangé.`
      : `« ${n} », vide.`;
  });

  constructor() {
    this.api.dashboards().subscribe((d) => {
      this.existing.set(d);
      const pre = d.find((x) => x.id === this.copy());
      if (pre) this.pick(pre);
    });
  }

  protected pick(d: DashboardInfo | null) {
    const previous = this.from();
    this.from.set(d);
    // Propose un nom tant que l'utilisateur n'a pas écrit le sien.
    if (!this.name().trim() || (previous && this.name() === `${previous.name} (copie)`)) this.name.set(d ? `${d.name} (copie)` : '');
  }

  protected create() {
    const name = this.name().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const done = { next: (d: { id: string }) => this.router.navigate(['/dashboards', d.id], { queryParams: { edit: 1 } }), error: (e: { error?: { error?: string } }) => {
      this.busy.set(false);
      this.error.set(e?.error?.error ?? 'Création impossible.');
    } };
    const description = this.description.trim() || null;
    const f = this.from();
    if (!f) {
      this.api.createDashboard({ name, description, panels: [] }).subscribe(done);
      return;
    }
    this.api.dashboard(f.id).subscribe((src) =>
      this.api.createDashboard({ name, description: description ?? src.description, panels: src.panels, variables: src.variables }).subscribe(done));
  }
}
