import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, DashboardInfo } from '../core/api';
import { AgoPipe } from '../core/format';

@Component({
  selector: 'vg-dashboards',
  imports: [RouterLink, FormsModule, AgoPipe],
  template: `
    <div class="page">
      <form class="page-head" (ngSubmit)="create()">
        <h1>Tableaux de bord</h1>
        <span class="spacer"></span>
        <input name="name" [(ngModel)]="name" placeholder="Nom du nouveau tableau" />
        <button class="btn" type="submit" [disabled]="!name.trim()">Créer</button>
      </form>
      <section class="panel">
        <table class="list">
          <thead><tr><th>Nom</th><th>Description</th><th class="r">Panneaux</th><th>Modifié</th></tr></thead>
          <tbody>
            @for (d of items(); track d.id) {
              <tr class="click" [routerLink]="['/dashboards', d.id]">
                <td>{{ d.name }}</td>
                <td class="muted">{{ d.description ?? '' }}</td>
                <td class="r">{{ d.panels }}</td>
                <td class="muted nowrap">{{ d.updatedAt | ago }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="empty">Aucun tableau de bord.</td></tr>
            }
          </tbody>
        </table>
      </section>
    </div>
  `,
  styles: `input { width: 240px; }`,
})
export class DashboardsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly items = signal<DashboardInfo[]>([]);
  protected name = '';

  constructor() {
    this.api.dashboards().subscribe((d) => this.items.set(d));
  }

  create() {
    this.api.createDashboard({ name: this.name.trim(), panels: [] }).subscribe((d) =>
      this.router.navigate(['/dashboards', d.id], { queryParams: { edit: 1 } }),
    );
  }
}
