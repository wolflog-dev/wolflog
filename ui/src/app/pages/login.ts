import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Session } from '../core/state';

@Component({
  selector: 'vg-login',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <form class="box" (ngSubmit)="submit()">
        <div class="brand">vigil</div>
        <label>Utilisateur <input name="u" [(ngModel)]="username" autocomplete="username" required /></label>
        <label>Mot de passe <input name="p" type="password" [(ngModel)]="password" autocomplete="current-password" required autofocus /></label>
        @if (error()) {
          <div class="error">{{ error() }}</div>
        }
        <button class="btn primary" type="submit" [disabled]="busy()">{{ busy() ? 'Connexion…' : 'Se connecter' }}</button>
        <p class="muted small">Identifiants perdus : lancer <code>vigil credentials</code> sur le serveur.</p>
      </form>
    </div>
  `,
  styles: `
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
    .box { width: min(320px, 100%); display: grid; gap: 12px; }
    .brand { font: 700 20px var(--mono); letter-spacing: -.02em; margin-bottom: 8px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    input { height: 32px; }
    .btn { justify-content: center; height: 32px; }
    .error { color: var(--danger); font-size: 12.5px; }
    p { margin: 4px 0 0; }
  `,
})
export class LoginPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  readonly returnUrl = input<string>('/');
  protected username = 'admin';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  submit() {
    this.busy.set(true);
    this.error.set('');
    this.api.login(this.username, this.password).subscribe({
      next: async () => {
        await this.session.load();
        this.router.navigateByUrl(this.returnUrl() || '/');
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Utilisateur ou mot de passe incorrect.');
      },
    });
  }
}
