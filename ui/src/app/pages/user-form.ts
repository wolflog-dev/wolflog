import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, Role } from '../core/api';
import { Session } from '../core/state';
import { CopyText } from '../shared/widgets';
import { ROLE_LABELS } from './admin-users';

/** Ajout d'un utilisateur : identité, rôle, puis le mot de passe provisoire à transmettre. */
@Component({
  selector: 'vg-user-form',
  imports: [FormsModule, RouterLink, CopyText],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/admin/users" class="small">Utilisateurs</a>
        <span class="muted">/</span>
        <h1>Ajouter un utilisateur</h1>
        <span class="spacer"></span>
        @if (!created()) {
          <a class="btn" routerLink="/admin/users">Annuler</a>
          <button class="btn primary" (click)="create()" [disabled]="busy() || !username.trim()">Créer le compte</button>
        } @else {
          <a class="btn primary" routerLink="/admin/users">Terminé</a>
        }
      </div>

      @if (created(); as c) {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step done">
              <div class="step-head"><span class="num">3</span><h2>Compte « {{ c.username }} » créé</h2></div>
              <div class="step-body">
                <p>Mot de passe provisoire : <code class="secret">{{ c.password }}</code> <vg-copy [text]="c.password" /></p>
                <p class="muted small">Transmettez-le à la personne avec l'adresse de Vigil ({{ origin }}). Il ne sera plus affiché ;
                  elle devra choisir son propre mot de passe à la première connexion.</p>
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="actions"><a class="btn primary" routerLink="/admin/users">Terminé</a><a class="btn" routerLink="/admin/users/new" (click)="reset()">Ajouter un autre</a></div>
          </aside>
        </div>
      } @else {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step done">
              <div class="step-head"><span class="num">1</span><h2>Qui ?</h2></div>
              <div class="step-body">
                <div class="options">
                  <label class="field">Nom d'utilisateur <input [(ngModel)]="username" autocomplete="off" placeholder="ex. jdupont" /></label>
                  <label class="field">Nom affiché <input [(ngModel)]="displayName" autocomplete="off" placeholder="ex. Jeanne Dupont" /></label>
                  <label class="field">E-mail <input type="email" [(ngModel)]="email" autocomplete="off" placeholder="facultatif" /></label>
                </div>
                @if (session.me()?.sso; as sso) {
                  <p class="muted small">Les personnes qui se connectent avec {{ sso.name }} sont ajoutées automatiquement : inutile de créer leur compte.</p>
                }
              </div>
            </section>
            <section class="panel step done">
              <div class="step-head"><span class="num">2</span><h2>Quels droits ?</h2></div>
              <div class="step-body">
                <div class="choices">
                  @for (r of roles; track r) {
                    <button type="button" class="choice" [class.on]="role() === r" (click)="role.set(r)">
                      <strong>{{ labels[r].label }}</strong><span>{{ labels[r].hint }}</span>
                    </button>
                  }
                </div>
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="block">
              <h3>Résumé</h3>
              <p class="phrase">{{ summary() }}</p>
              <p class="muted small">Un mot de passe provisoire sera généré et affiché une seule fois.</p>
            </div>
            @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
            <div class="actions">
              <button class="btn primary" (click)="create()" [disabled]="busy() || !username.trim()">Créer le compte</button>
              <a class="btn" routerLink="/admin/users">Annuler</a>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  styles: `
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 220px; }
    .secret { font-size: 14px; padding: 4px 8px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); user-select: all; }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    p { margin: 0; }
  `,
})
export class UserFormPage {
  private readonly api = inject(Api);
  protected readonly session = inject(Session);
  protected readonly roles: Role[] = ['viewer', 'editor', 'admin'];
  protected readonly labels = ROLE_LABELS;
  protected readonly role = signal<Role>('viewer');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly created = signal<{ username: string; password: string } | null>(null);
  protected readonly origin = location.origin;
  protected username = '';
  protected displayName = '';
  protected email = '';

  protected readonly summary = computed(() => `Compte ${this.labels[this.role()].label.toLowerCase()} : ${this.labels[this.role()].hint.toLowerCase()}.`);

  protected create() {
    this.error.set('');
    this.busy.set(true);
    this.api.createUser({ username: this.username.trim(), displayName: this.displayName.trim(), email: this.email.trim(), role: this.role() }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.created.set({ username: r.user.username, password: r.temporaryPassword });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Création impossible.');
      },
    });
  }

  protected reset() {
    this.created.set(null);
    this.username = this.displayName = this.email = '';
    this.role.set('viewer');
  }
}
