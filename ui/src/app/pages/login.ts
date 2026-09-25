import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, Me } from '../core/api';
import { Session } from '../core/state';

import { Logo } from '../shared/logo';

@Component({
  selector: 'wl-login',
  imports: [FormsModule, Logo],
  template: `
    <div class="wrap">
      <div class="box">
        <div class="brand"><wl-logo [size]="28" />wolflog</div>
        @if (me()?.sso; as sso) {
          <a class="btn primary sso" [href]="ssoUrl()">Se connecter avec {{ sso.name }}</a>
          @if (ssoParam() === 'error') {
            <div class="error">La connexion avec {{ sso.name }} a échoué ou ce compte est désactivé dans Wolflog.</div>
          }
          <div class="or muted small"><span>ou avec un compte Wolflog</span></div>
        }
        <form (ngSubmit)="submit()">
          <label>Utilisateur <input name="u" [(ngModel)]="username" autocomplete="username" required /></label>
          <label>Mot de passe <input name="p" type="password" [(ngModel)]="password" autocomplete="current-password" required autofocus /></label>
          @if (error()) {
            <div class="error">{{ error() }}</div>
          }
          <button class="btn" [class.primary]="!me()?.sso" type="submit" [disabled]="busy()">{{ busy() ? 'Connexion…' : 'Se connecter' }}</button>
        </form>
        <p class="muted small">Mot de passe oublié : un administrateur peut le réinitialiser, ou sur le serveur <code>wolflog reset-password</code>.</p>
      </div>
    </div>
  `,
  styles: `
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
    .box, form { width: min(320px, 100%); display: grid; gap: 12px; }
    .brand { display: flex; align-items: center; gap: 10px; font: 700 20px var(--mono); letter-spacing: -.02em; margin-bottom: 8px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    input { height: 32px; }
    .btn { justify-content: center; height: 32px; }
    .error { color: var(--danger); font-size: 12.5px; }
    .or { display: flex; align-items: center; gap: 8px; }
    .or::before, .or::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
    p { margin: 4px 0 0; }
  `,
})
export class LoginPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  readonly returnUrl = input<string>('/');
  readonly ssoParam = input<string>('', { alias: 'sso' });
  protected readonly me = signal<Me | null>(null);
  protected username = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  constructor() {
    this.api.me().subscribe({
      next: (me) => {
        if (me.authenticated) {
          this.session.me.set(me);
          this.router.navigateByUrl(this.returnUrl() || '/');
        }
        this.me.set(me);
      },
      error: () => {},
    });
  }

  protected ssoUrl() {
    return '/api/auth/sso?returnUrl=' + encodeURIComponent(this.returnUrl() || '/');
  }

  submit() {
    this.busy.set(true);
    this.error.set('');
    this.api.login(this.username, this.password).subscribe({
      next: async () => {
        const me = await this.session.load();
        this.router.navigateByUrl(me.mustChangePassword ? '/account?first=1' : this.returnUrl() || '/');
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Utilisateur ou mot de passe incorrect.');
      },
    });
  }
}
