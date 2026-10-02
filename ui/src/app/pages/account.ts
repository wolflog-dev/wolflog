import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { NavIcon } from '../shared/nav-icon';
import { PreferencesPanel } from '../shared/preferences-panel';
import { ROLE_LABELS, nameHue, nameInitials } from './admin-users';

/** Robustesse d'un mot de passe : 0 (vide) à 4 (excellent), avec son libellé et sa teinte. */
function passwordStrength(p: string): { level: number; label: string; tone: string } {
  if (!p) return { level: 0, label: '10 caractères minimum', tone: 'var(--text-3)' };
  if (p.length < 10) {
    const missing = 10 - p.length;
    return { level: 1, label: `Trop court : encore ${missing} caractère${missing > 1 ? 's' : ''}`, tone: 'var(--danger)' };
  }
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\p{L}\p{N}]/u].filter((r) => r.test(p)).length;
  const score = kinds + (p.length >= 14 ? 1 : 0) + (p.length >= 20 ? 1 : 0);
  if (score <= 2) return { level: 2, label: 'Correct', tone: 'var(--warn)' };
  if (score <= 4) return { level: 3, label: 'Solide', tone: 'var(--ok)' };
  return { level: 4, label: 'Excellent', tone: 'var(--ok)' };
}

/** Mon compte : identité, rôle, mode de connexion, préférences d'affichage et changement de mot de passe. */
@Component({
  selector: 'wl-account',
  imports: [FormsModule, NavIcon, PreferencesPanel],
  template: `
    <div class="page narrow">
      <div class="page-head"><h1>Mon compte</h1></div>

      @if (first() && me()?.mustChangePassword) {
        <div class="panel notice" role="status">
          <span class="notice-icon"><wl-nav-icon name="lock" [size]="18" /></span>
          <div><strong>Mot de passe provisoire</strong>
            <span>Vous vous connectez avec un mot de passe provisoire. Choisissez votre mot de passe pour continuer.</span></div>
        </div>
      }

      @if (me(); as m) {
        <section class="panel profile">
          <div class="identity">
            <span class="avatar" [style.--hue]="hue()">{{ initials() }}</span>
            <div class="who">
              <strong class="ellipsis">{{ m.displayName || m.user }}</strong>
              <span class="mono muted small ellipsis">{{ m.user }}</span>
            </div>
            <span class="spacer"></span>
            <span class="pill" [style.--tone]="role().tone" [title]="role().hint"><wl-nav-icon [name]="role().icon" [size]="13" />{{ role().label }}</span>
          </div>
          <dl class="facts">
            <div><dt><wl-nav-icon name="account" [size]="14" />Utilisateur</dt><dd class="mono">{{ m.user }}</dd></div>
            <div><dt><wl-nav-icon name="text" [size]="14" />Nom affiché</dt><dd>@if (m.displayName) { {{ m.displayName }} } @else { <span class="muted">non renseigné</span> }</dd></div>
            <div><dt><wl-nav-icon [name]="role().icon" [size]="14" />Rôle</dt><dd>{{ role().label }} <span class="muted small">· {{ role().hint }}</span></dd></div>
            <div><dt><wl-nav-icon [name]="m.source === 'sso' ? 'shield' : m.source === 'ldap' ? 'building' : 'lock'" [size]="14" />Connexion</dt>
              <dd>{{ m.source === 'sso' ? 'Connexion unique (' + (m.sso?.name ?? 'SSO') + ')'
                : m.source === 'ldap' ? 'Annuaire de l’entreprise' + (m.sso?.ldapLabel ? ' (' + m.sso.ldapLabel + ')' : '') + ', mot de passe géré par l’annuaire'
                : 'Mot de passe Wolflog' }}</dd></div>
          </dl>
        </section>

        @if (m.source !== 'sso' && m.source !== 'ldap' && m.authEnabled) {
          <section class="panel">
            <div class="panel-head">
              <h2>Changer de mot de passe</h2>
              <span class="spacer"></span>
              <label class="check small"><input type="checkbox" class="switch" [checked]="reveal()" (change)="reveal.set(!reveal())" /> Afficher</label>
            </div>
            <form class="panel-body form" (ngSubmit)="change()">
              <label class="field">Mot de passe actuel
                <input name="cur" [type]="reveal() ? 'text' : 'password'" [(ngModel)]="current" autocomplete="current-password" required /></label>
              <label class="field">Nouveau mot de passe
                <input name="next" [type]="reveal() ? 'text' : 'password'" [(ngModel)]="next" autocomplete="new-password" required minlength="10" />
                <span class="strength" [style.--tone]="strength().tone">
                  <span class="meter" aria-hidden="true">
                    @for (i of segments; track i) { <i [class.on]="i < strength().level" [style.--d]="i"></i> }
                  </span>
                  <span class="small">{{ strength().label }}</span>
                </span>
              </label>
              <label class="field">Confirmation
                <input name="confirm" [type]="reveal() ? 'text' : 'password'" [(ngModel)]="confirm" autocomplete="new-password" required />
                @if (confirm) {
                  <span class="match small" [class.same]="confirm === next" animate.enter="hint-in">
                    <wl-nav-icon [name]="confirm === next ? 'check' : 'close'" [size]="13" />{{ confirm === next ? 'Identique' : 'Différent du nouveau mot de passe' }}
                  </span>
                }
              </label>
              @if (error()) { <p class="message bad" role="alert" animate.enter="hint-in"><wl-nav-icon name="warning" [size]="14" />{{ error() }}</p> }
              @if (done()) { <p class="message good" role="status" animate.enter="hint-in"><wl-nav-icon name="ok" [size]="14" />Mot de passe modifié.</p> }
              <div>
                <button class="btn primary" type="submit" [disabled]="busy()">
                  <wl-nav-icon [name]="busy() ? 'refresh' : 'check'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Enregistrement…' : 'Enregistrer' }}
                </button>
              </div>
            </form>
          </section>
        }
      }

      <section class="panel prefs-panel">
        <div class="panel-head"><wl-nav-icon name="sparkles" [size]="15" /><h2>Mes préférences</h2></div>
        <div class="panel-body"><wl-preferences-panel /></div>
      </section>
    </div>
  `,
  styles: `
    .narrow { max-width: 680px; }
    .notice { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
    .notice > div { display: grid; gap: 2px; color: var(--text-2); }
    .notice strong { color: var(--text-1); }
    .notice-icon { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; color: var(--warn);
      background: color-mix(in srgb, var(--warn) 15%, transparent); animation: wiggle 2.6s var(--ease) .6s 2; }
    @keyframes wiggle { 0%, 60%, 100% { transform: none; } 70% { transform: rotate(-12deg); } 80% { transform: rotate(9deg); } 90% { transform: rotate(-5deg); } }

    .identity { display: flex; align-items: center; gap: 14px; padding: 18px 20px; border-bottom: 1px solid var(--border-soft); }
    .avatar { flex: none; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; color: #fff; font: 700 18px/1 var(--sans);
      letter-spacing: .02em; background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%));
      box-shadow: 0 10px 22px -10px hsl(var(--hue) 70% 45%), inset 0 1px 0 rgb(255 255 255 / .35); animation: pop-in .6s var(--spring) .15s backwards; }
    @keyframes pop-in { from { opacity: 0; transform: scale(.5) rotate(-12deg); } }
    .who { display: grid; gap: 2px; min-width: 0; }
    .who strong { font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
    .pill { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px 0 9px; border-radius: 999px; font: 600 12px var(--sans);
      color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 30%, transparent); }
    .facts { display: grid; margin: 0; padding: 6px 0; }
    .facts > div { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 12px; padding: 8px 20px; transition: background-color .15s; }
    .facts > div:hover { background-color: var(--row-hover); }
    .facts dt { display: flex; align-items: center; gap: 8px; color: var(--text-3); }
    .facts dt wl-nav-icon { color: var(--accent); opacity: .8; }
    .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

    .form { display: grid; gap: 14px; max-width: 380px; }
    .field { display: grid; gap: 5px; font-size: 12px; color: var(--text-2); }
    .strength { display: flex; align-items: center; gap: 10px; color: var(--tone); }
    .meter { display: flex; gap: 4px; width: 132px; flex: none; }
    .meter i { position: relative; flex: 1; height: 4px; overflow: hidden; border-radius: 2px; background: var(--surface-3); }
    .meter i::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: var(--tone); transform: scaleX(0); transform-origin: left;
      transition: transform .4s var(--ease), background-color .3s; transition-delay: calc(var(--d) * 60ms); }
    .meter i.on::after { transform: scaleX(1); }
    .match { display: inline-flex; align-items: center; gap: 5px; color: var(--danger); }
    .match.same { color: var(--ok); }
    .message { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 12.5px; }
    .message.bad { color: var(--danger); }
    .message.good { color: var(--ok); }
    .btn wl-nav-icon.spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hint-in { animation: hint-in .35s var(--spring); }
    @keyframes hint-in { from { opacity: 0; transform: translateY(-4px); } }
    @media (max-width: 600px) { .facts > div { grid-template-columns: minmax(0, 1fr); gap: 2px; } }
  `,
})
export class AccountPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  readonly first = input<string>('');
  protected readonly me = this.session.me;
  /** Rôle courant : libellé, explication, icône et teinte. */
  protected readonly role = computed(() => ROLE_LABELS[this.me()?.role ?? 'viewer'] ?? ROLE_LABELS.viewer);
  protected readonly initials = computed(() => nameInitials(this.me()?.displayName || this.me()?.user || '?'));
  protected readonly hue = computed(() => nameHue(this.me()?.user ?? ''));
  protected readonly segments = [0, 1, 2, 3];
  protected current = '';
  protected next = '';
  protected confirm = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly done = signal(false);
  /** Mots de passe affichés en clair. */
  protected readonly reveal = signal(false);

  /** Relu à chaque saisie (champ lié par ngModel). */
  protected strength() {
    return passwordStrength(this.next);
  }

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
        this.toasts.ok('Mot de passe modifié', 'lock');
        this.current = this.next = this.confirm = '';
        const wasFirst = this.me()?.mustChangePassword;
        await this.session.load();
        if (wasFirst) this.router.navigateByUrl('/');
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Modification impossible.');
        this.toasts.error(this.error());
      },
    });
  }
}
