import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { ROLE_LABELS } from './admin-users';

@Component({
  selector: 'wl-account',
  imports: [FormsModule],
  template: `
    <div class="page narrow">
      <div class="page-head"><h1>Mon compte</h1></div>

      @if (first() && me()?.mustChangePassword) {
        <div class="panel notice">Vous vous connectez avec un mot de passe provisoire. Choisissez votre mot de passe pour continuer.</div>
      }

      @if (me(); as m) {
        <section class="panel">
          <div class="panel-head"><h2>Profil</h2></div>
          <table class="kv">
            <tr><td>Utilisateur</td><td class="mono">{{ m.user }}</td></tr>
            <tr><td>Nom affiché</td><td>{{ m.displayName }}</td></tr>
            <tr><td>Rôle</td><td>{{ roleLabel() }}</td></tr>
            <tr><td>Connexion</td><td>{{ m.source === 'sso' ? 'Connexion unique (' + (m.sso?.name ?? 'SSO') + ')' : 'Mot de passe Wolflog' }}</td></tr>
          </table>
        </section>

        @if (m.source !== 'sso' && m.authEnabled) {
          <section class="panel">
            <div class="panel-head"><h2>Changer de mot de passe</h2></div>
            <form class="panel-body form" (ngSubmit)="change()">
              <label>Mot de passe actuel <input name="cur" type="password" [(ngModel)]="current" autocomplete="current-password" required /></label>
              <label>Nouveau mot de passe <input name="next" type="password" [(ngModel)]="next" autocomplete="new-password" required minlength="10" />
                <span class="muted small">10 caractères minimum.</span></label>
              <label>Confirmation <input name="confirm" type="password" [(ngModel)]="confirm" autocomplete="new-password" required /></label>
              @if (error()) { <p class="danger small">{{ error() }}</p> }
              @if (done()) { <p class="ok small">Mot de passe modifié.</p> }
              <div><button class="btn primary" type="submit" [disabled]="busy()">Enregistrer</button></div>
            </form>
          </section>
        }
      }
    </div>
  `,
  styles: `
    .narrow { max-width: 640px; }
    .notice { padding: 10px 12px; border-color: var(--warn); color: var(--text-1); }
    .kv { border-collapse: collapse; margin: 8px 0; }
    .kv td { padding: 4px 12px; }
    .kv td:first-child { color: var(--text-3); width: 140px; }
    .form { display: grid; gap: 12px; max-width: 360px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    p { margin: 0; }
  `,
})
export class AccountPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  readonly first = input<string>('');
  protected readonly me = this.session.me;
  protected readonly roleLabel = computed(() => ROLE_LABELS[this.me()?.role ?? 'viewer']?.label ?? '');
  protected current = '';
  protected next = '';
  protected confirm = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly done = signal(false);

  change() {
    this.error.set('');
    this.done.set(false);
    if (this.next.length < 10) return this.error.set('10 caractères minimum.');
    if (this.next !== this.confirm) return this.error.set('La confirmation ne correspond pas.');
    this.busy.set(true);
    this.api.changePassword(this.current, this.next).subscribe({
      next: async () => {
        this.busy.set(false);
        this.done.set(true);
        this.current = this.next = this.confirm = '';
        const wasFirst = this.me()?.mustChangePassword;
        await this.session.load();
        if (wasFirst) this.router.navigateByUrl('/');
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Modification impossible.');
      },
    });
  }
}
