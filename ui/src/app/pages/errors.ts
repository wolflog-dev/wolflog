import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api, ErrorGroup } from '../core/api';
import { AppState } from '../core/state';
import { AgoPipe, NumPipe } from '../core/format';

@Component({
  selector: 'vg-errors',
  imports: [FormsModule, RouterLink, NumPipe, AgoPipe],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Erreurs</h1>
        <span class="muted small">regroupées par type d'exception et pile d'appels</span>
        <span class="spacer"></span>
        <div class="seg">
          <button [class.on]="!crashOnly()" (click)="crashOnly.set(false)">Toutes</button>
          <button [class.on]="crashOnly()" (click)="crashOnly.set(true)">Crashs</button>
        </div>
        <form (ngSubmit)="applied.set(text)">
          <input name="q" [(ngModel)]="text" placeholder="Type ou message" class="filter" />
        </form>
      </div>

      <section class="panel">
        @if (groups().length) {
          <table class="list">
            <thead>
              <tr><th>Exception</th><th>Service</th><th class="r">Occurrences</th><th>Dernière</th><th>Première</th></tr>
            </thead>
            <tbody>
              @for (g of groups(); track g.fingerprint) {
                <tr class="click" [routerLink]="['/errors', g.fingerprint]">
                  <td class="main">
                    <div class="ellipsis">
                      @if (g.crashes) { <span class="tag crash">crash</span> }
                      <span class="mono">{{ g.exceptionType }}</span>
                    </div>
                    <div class="muted small ellipsis">{{ g.message }}</div>
                  </td>
                  <td class="nowrap">{{ g.service }}@if (g.services > 1) { <span class="muted"> +{{ g.services - 1 }}</span> }</td>
                  <td class="r">{{ g.count | num }}</td>
                  <td class="muted nowrap">{{ g.lastSeen | ago }}</td>
                  <td class="muted nowrap">{{ g.firstSeen | ago }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loading()) {
          <div class="empty">Aucune erreur sur cette période.</div>
        }
      </section>
    </div>
  `,
  styles: `
    .filter { width: 240px; }
    .main { max-width: 0; width: 60%; }
    .tag { margin-right: 6px; }
  `,
})
export class ErrorsPage {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);
  readonly q = input<string>('');
  protected readonly groups = signal<ErrorGroup[]>([]);
  protected readonly loading = signal(false);
  protected readonly crashOnly = signal(false);
  protected readonly applied = signal('');
  protected text = '';
  private sub?: Subscription;

  constructor() {
    effect(() => {
      const q = this.q();
      untracked(() => {
        if (q?.includes('crash:true')) this.crashOnly.set(true);
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.crashOnly();
      this.applied();
      untracked(() => this.load());
    });
  }

  private load() {
    this.sub?.unsubscribe();
    this.loading.set(true);
    const q = [this.applied(), this.crashOnly() ? 'crash:true' : ''].filter(Boolean).join(' ');
    this.sub = this.api.errors(this.state.range(), q, this.state.service()).subscribe({
      next: (g) => {
        this.groups.set(g);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
