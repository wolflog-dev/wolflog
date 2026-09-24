import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, Role, UserAccount } from '../core/api';
import { Session } from '../core/state';
import { AgoPipe } from '../core/format';
import { CopyText } from '../shared/widgets';

export const ROLE_LABELS: Record<Role, { label: string; hint: string }> = {
  viewer: { label: 'Lecteur', hint: 'Consulte tout, ne modifie rien' },
  editor: { label: 'Éditeur', hint: 'Tableaux de bord, statut des erreurs, alertes, recherches partagées' },
  admin: { label: 'Administrateur', hint: 'Tout, plus les utilisateurs, clés API, sources et sauvegardes' },
};

@Component({
  selector: 'vg-admin-users',
  imports: [FormsModule, AgoPipe, CopyText],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Utilisateurs</h1>
        <span class="muted small">{{ users().length }} compte(s)</span>
        <span class="spacer"></span>
        @if (!adding()) { <button class="btn primary" (click)="startAdd()">Ajouter un utilisateur</button> }
      </div>

      @if (secret(); as s) {
        <div class="panel secret">
          <div>Mot de passe provisoire de <strong>{{ s.user }}</strong> : <code>{{ s.password }}</code> <vg-copy [text]="s.password" /></div>
          <div class="muted small">Transmettez-le à la personne : il ne sera plus affiché. Elle devra le changer à la première connexion.</div>
          <button class="btn ghost" (click)="secret.set(null)">Fermer</button>
        </div>
      }

      @if (adding()) {
        <form class="panel add" (ngSubmit)="create()">
          <label>Nom d'utilisateur <input name="u" [(ngModel)]="form.username" required autocomplete="off" #first /></label>
          <label>Nom affiché <input name="d" [(ngModel)]="form.displayName" autocomplete="off" /></label>
          <label>E-mail <input name="e" type="email" [(ngModel)]="form.email" autocomplete="off" /></label>
          <label>Rôle
            <select name="r" [(ngModel)]="form.role">
              @for (r of roles; track r) { <option [value]="r">{{ roleLabels[r].label }}</option> }
            </select>
          </label>
          <div class="actions">
            <button class="btn primary" type="submit" [disabled]="!form.username.trim()">Créer</button>
            <button class="btn" type="button" (click)="adding.set(false)">Annuler</button>
          </div>
          <div class="muted small full">{{ roleLabels[form.role].hint }}. Un mot de passe provisoire sera généré.</div>
        </form>
      }
      @if (error()) { <p class="danger small">{{ error() }}</p> }

      <section class="panel">
        <table class="list">
          <thead><tr><th>Utilisateur</th><th>Rôle</th><th>Connexion</th><th>Dernière connexion</th><th>État</th><th></th></tr></thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr [class.off]="u.disabled">
                <td>
                  <div>{{ u.displayName || u.username }} @if (u.id === meId()) { <span class="muted small">(vous)</span> }</div>
                  <div class="muted small mono">{{ u.username }}{{ u.email ? ' · ' + u.email : '' }}</div>
                </td>
                <td>
                  <select [value]="u.role" (change)="update(u, { role: $any($event.target).value })" [title]="roleLabels[u.role].hint" aria-label="Rôle">
                    @for (r of roles; track r) { <option [value]="r">{{ roleLabels[r].label }}</option> }
                  </select>
                </td>
                <td class="small">{{ u.source === 'sso' ? 'SSO' : 'Mot de passe' }}@if (u.mustChangePassword) { <span class="muted"> · provisoire</span> }</td>
                <td class="small muted nowrap">{{ u.lastLoginAt ? (u.lastLoginAt | ago) : 'jamais' }}</td>
                <td class="small">{{ u.disabled ? 'Désactivé' : 'Actif' }}</td>
                <td class="acts nowrap">
                  @if (confirmDelete() === u.id) {
                    <span class="small">Supprimer {{ u.username }} ?</span>
                    <button class="btn danger-btn" (click)="remove(u)">Supprimer</button>
                    <button class="btn ghost" (click)="confirmDelete.set(null)">Annuler</button>
                  } @else {
                    <button class="btn ghost" (click)="reset(u)" title="Génère un mot de passe provisoire">Nouveau mot de passe</button>
                    @if (u.id !== meId()) {
                      <button class="btn ghost" (click)="update(u, { disabled: !u.disabled })">{{ u.disabled ? 'Réactiver' : 'Désactiver' }}</button>
                      <button class="btn ghost" (click)="confirmDelete.set(u.id)">Supprimer</button>
                    }
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </section>

      <div class="muted small legend">
        @for (r of roles; track r) { <div><strong>{{ roleLabels[r].label }}</strong> : {{ roleLabels[r].hint }}.</div> }
        @if (session.me()?.sso; as sso) {
          <div>Les personnes qui se connectent avec {{ sso.name }} sont ajoutées automatiquement ; leur rôle peut suivre les groupes de l'annuaire (configuration <code>Vigil:Auth:Oidc</code>).</div>
        }
      </div>
    </div>
  `,
  styles: `
    .secret { display: grid; gap: 4px; padding: 10px 12px; border-color: var(--ok); position: relative; }
    .secret .btn { position: absolute; right: 8px; top: 8px; }
    .add { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 10px; align-items: end; padding: 12px; }
    .add .full { grid-column: 1 / -1; }
    .add .actions { display: flex; gap: 8px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    tr.off td { color: var(--text-3); }
    .acts { text-align: right; width: 1%; }
    .acts .btn { height: 24px; font-size: 12px; }
    tr:not(:hover) .acts .btn.ghost { visibility: hidden; }
    .danger-btn { color: var(--danger); border-color: var(--danger); }
    .legend { display: grid; gap: 2px; }
    p { margin: 0; }
    @media (max-width: 900px) { .add { grid-template-columns: 1fr 1fr; } }
  `,
})
export class AdminUsersPage {
  private readonly api = inject(Api);
  protected readonly session = inject(Session);
  protected readonly users = signal<UserAccount[]>([]);
  protected readonly adding = signal(false);
  protected readonly error = signal('');
  protected readonly secret = signal<{ user: string; password: string } | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly roles: Role[] = ['viewer', 'editor', 'admin'];
  protected readonly roleLabels = ROLE_LABELS;
  protected form = { username: '', displayName: '', email: '', role: 'viewer' as Role };

  constructor() {
    this.load();
  }

  protected meId() {
    return this.users().find((u) => u.username === this.session.me()?.user)?.id;
  }

  private load() {
    this.api.users().subscribe((u) => this.users.set(u));
  }

  private fail = (e: { error?: { error?: string } }) => this.error.set(e?.error?.error ?? 'Opération impossible.');

  protected startAdd() {
    this.form = { username: '', displayName: '', email: '', role: 'viewer' };
    this.adding.set(true);
    setTimeout(() => (document.querySelector('vg-admin-users form input') as HTMLInputElement | null)?.focus());
  }

  protected create() {
    this.error.set('');
    this.api.createUser({ ...this.form, username: this.form.username.trim() }).subscribe({
      next: (r) => {
        this.adding.set(false);
        this.secret.set({ user: r.user.username, password: r.temporaryPassword });
        this.load();
      },
      error: this.fail,
    });
  }

  protected update(u: UserAccount, change: Partial<{ role: Role; disabled: boolean }>) {
    this.error.set('');
    this.api.updateUser(u.id, change).subscribe({ next: () => this.load(), error: (e) => { this.fail(e); this.load(); } });
  }

  protected reset(u: UserAccount) {
    this.error.set('');
    this.api.resetPassword(u.id).subscribe({
      next: (r) => {
        this.secret.set({ user: u.username, password: r.temporaryPassword });
        this.load();
      },
      error: this.fail,
    });
  }

  protected remove(u: UserAccount) {
    this.confirmDelete.set(null);
    this.api.deleteUser(u.id).subscribe({ next: () => this.load(), error: this.fail });
  }
}
