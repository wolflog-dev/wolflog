import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { DashboardInfo } from '../core/models';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { Session } from '../core/session';

@Component({
  selector: 'wl-dashboards',
  imports: [RouterLink, AgoPipe],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Tableaux de bord</h1>
        <span class="spacer"></span>
        @if (session.canEdit()) { <a class="btn primary" routerLink="/dashboards/new">Nouveau tableau</a> }
      </div>
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
})
export class DashboardsPage {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  protected readonly items = signal<DashboardInfo[]>([]);

  constructor() {
    this.api.dashboards().subscribe((d) => this.items.set(d));
  }
}
