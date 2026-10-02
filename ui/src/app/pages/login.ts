import { Component, DestroyRef, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Branding } from '../core/branding';
import { Me } from '../core/models';
import { Session } from '../core/session';

import { Logo } from '../shared/logo';
import { MicrosoftLogo } from '../shared/microsoft-logo';
import { NavIcon } from '../shared/nav-icon';

/** Retour d'une connexion unique en échec (/login?sso=…) : la raison, sans jargon. {name} : le fournisseur. */
const SSO_ERRORS: Record<string, string> = {
  error: 'La connexion avec {name} a échoué. Réessayez ; si cela se reproduit, un administrateur trouvera la cause dans Administration > Connexion SSO.',
  denied: 'Connexion annulée : l’autorisation a été refusée ou la demande abandonnée.',
  disabled: 'Ce compte est désactivé dans Wolflog : contactez un administrateur.',
  domain: 'Ce compte n’appartient pas à un domaine autorisé dans Wolflog.',
  conflict: 'Un compte Wolflog local porte déjà ce nom : un administrateur doit le renommer ou le supprimer.',
  identity: 'Le fournisseur n’a transmis aucun identifiant utilisable.',
  windows: 'La connexion Windows a échoué : le navigateur n’a pas transmis votre session Windows (ordinateur hors du domaine, ou adresse de Wolflog absente de la zone intranet).',
};

/**
 * Connexion : carte en verre qui entre avec un rebond, logo animé, champs à icône, mot de passe affichable,
 * avertissement « majuscules », tremblement de la carte en cas d'échec et bouton qui tourne pendant la connexion.
 */
@Component({
  selector: 'wl-login',
  imports: [FormsModule, Logo, MicrosoftLogo, NavIcon],
  template: `
    <div class="wrap">
      <div class="card glass">
        <!-- Nom et logo de l'entreprise (page Personnalisation) avec « propulsé par Wolflog », puis message d'accueil. -->
        <div class="head">
          <div class="brand" [class.company]="branding.branded()">
            @if (branding.logoUrl(); as logo) {
              <span class="company-logo"><img [src]="logo" [alt]="branding.name() ? '' : 'Logo de l’entreprise'" /></span>
            } @else {
              <span class="logo"><wl-logo [size]="30" /></span>
            }
            <div class="titles">
              @if (branding.branded()) {
                @if (branding.name(); as name) { <span class="name company-name">{{ name }}</span> }
                <span class="powered"><wl-logo [size]="12" />propulsé par Wolflog</span>
              } @else {
                <span class="name">wolflog</span>
                <span class="tagline">Logs, traces, métriques et audience</span>
              }
            </div>
          </div>
          @if (branding.loginMessage(); as message) {
            <p class="welcome">{{ message }}</p>
          }
        </div>

        @if (redirecting(); as target) {
          <!-- Connexion automatique : départ dans un instant, annulable. -->
          <div class="auto" role="status" aria-live="polite">
            <span class="auto-mark">
              @if (target === 'microsoft') { <wl-microsoft-logo [size]="22" /> } @else { <wl-nav-icon name="desktop" [size]="22" /> }
              <i class="auto-ring" aria-hidden="true"></i>
            </span>
            <strong>Connexion avec {{ target === 'windows' ? 'Windows' : me()?.sso?.name }}…</strong>
            <span class="auto-hint">{{ target === 'windows' ? 'Votre session Windows suffit, rien à saisir.' : 'Vous allez être redirigé vers Microsoft.' }}</span>
            <button type="button" class="auto-cancel" (click)="cancelAuto()">Annuler et choisir une autre méthode</button>
          </div>
        } @else {
          @if (ssoMessage(); as message) {
            <div class="error" role="alert"><wl-nav-icon name="warning" [size]="15" /><span>{{ message }}</span></div>
          }
          @if (me()?.sso; as sso) {
            @if (sso.microsoft || sso.oidc || sso.windows) {
              <div class="methods">
                @if (sso.microsoft) {
                  <a class="btn ms" [href]="ssoUrl()"><wl-microsoft-logo [size]="18" />Se connecter avec {{ sso.name }}</a>
                }
                @if (sso.oidc) {
                  <a class="btn primary sso" [href]="ssoUrl()"><wl-nav-icon name="shield" />Se connecter avec {{ sso.name }}</a>
                }
                @if (sso.windows) {
                  <a class="btn win" [href]="windowsUrl()"><wl-nav-icon name="desktop" [size]="17" />Se connecter avec Windows</a>
                }
              </div>
              <div class="or"><span>{{ sso.ldap ? 'ou avec votre identifiant' : 'ou avec un compte Wolflog' }}</span></div>
            }
          }
        }

        <form (ngSubmit)="submit()" [class.away]="redirecting()">
          <!-- Annuaire de l'entreprise activé : le même formulaire accepte l'identifiant de l'entreprise. -->
          <label class="field">{{ ldapHint() ? 'Identifiant' : 'Utilisateur' }}
            <span class="control">
              <wl-nav-icon class="lead" name="users" [size]="15" />
              <input name="u" [(ngModel)]="username" autocomplete="username" required spellcheck="false" autofocus (input)="error.set('')" />
            </span>
            @if (ldapHint(); as hint) { <span class="field-hint">{{ hint }}</span> }
          </label>
          <label class="field">Mot de passe
            <span class="control">
              <wl-nav-icon class="lead" name="lock" [size]="15" />
              <input #passwordBox name="p" class="with-toggle" [type]="reveal() ? 'text' : 'password'" [(ngModel)]="password" autocomplete="current-password"
                     required [attr.aria-invalid]="error() ? 'true' : null" (input)="error.set('')"
                     (keydown)="checkCaps($event)" (keyup)="checkCaps($event)" (blur)="capsLock.set(false)" />
              <button type="button" class="reveal" [class.on]="reveal()" (mousedown)="$event.preventDefault()" (click)="reveal.set(!reveal())"
                      [title]="reveal() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'"
                      [attr.aria-label]="reveal() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'" [attr.aria-pressed]="reveal()">
                <wl-nav-icon name="eye" [size]="15" />
              </button>
            </span>
          </label>
          <!-- Ligne de message toujours réservée : une erreur ou « Majuscules activées » ne change pas la taille de la carte. -->
          <div class="msg" [class.err]="!!error()" [class.caps]="!error() && capsLock()" role="alert" aria-live="polite">
            @if (error()) {
              <wl-nav-icon name="warning" [size]="14" /><span>{{ error() }}</span>
            } @else if (capsLock()) {
              <wl-nav-icon name="arrow-up" [size]="13" /><span>Majuscules activées</span>
            }
          </div>
          <button class="btn submit" [class.primary]="!me()?.sso" [class.busy]="busy()" type="submit" [disabled]="busy()">
            @if (busy()) {
              <wl-nav-icon class="spin" name="refresh" [size]="15" />Connexion…
            } @else {
              Se connecter<wl-nav-icon class="go" name="arrow-right" [size]="15" />
            }
          </button>
        </form>

        <p class="hint" [class.away]="redirecting()"><wl-nav-icon name="info" [size]="14" />
          @if (ldapHint()) {
            <span>Mot de passe oublié : celui de l'entreprise se change auprès de votre service informatique ; un compte Wolflog, auprès d'un administrateur.</span>
          } @else {
            <span>Mot de passe oublié : un administrateur peut le réinitialiser, ou sur le serveur <code>wolflog reset-password</code>.</span>
          }</p>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    /* Défile si la fenêtre est trop basse ; les marges automatiques centrent la carte sans jamais la rogner. */
    .wrap { height: 100vh; overflow: auto; display: flex; padding: 24px 16px; }
    .card { position: relative; width: min(380px, 100%); margin: auto; padding: 30px 30px 24px; display: grid; gap: 16px; border-radius: 26px;
      animation: card-in .75s var(--spring) backwards; }
    @keyframes card-in { from { opacity: 0; transform: translateY(26px) scale(.94); } }
    /* Contenu de la carte en cascade, juste après elle. */
    .card > * { animation: item-in .5s var(--ease) backwards; }
    .card > :nth-child(1) { animation-delay: .12s; } .card > :nth-child(2) { animation-delay: .2s; } .card > :nth-child(3) { animation-delay: .26s; }
    .card > :nth-child(4) { animation-delay: .32s; } .card > :nth-child(5) { animation-delay: .38s; } .card > :nth-child(6) { animation-delay: .44s; }
    @keyframes item-in { from { opacity: 0; transform: translateY(10px); } }

    .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
    .logo { position: relative; flex: none; display: grid; place-items: center; width: 56px; height: 56px; border-radius: 18px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 14px 30px -12px var(--accent), inset 0 1px 0 rgb(255 255 255 / .4);
      animation: logo-in .9s var(--spring) .15s backwards; }
    .logo ::ng-deep path { fill: #fff; }
    @keyframes logo-in { from { opacity: 0; transform: scale(.35) rotate(-28deg); } }
    .titles { display: grid; gap: 1px; min-width: 0; }
    .name { font: 750 24px/1.1 var(--mono); letter-spacing: -.03em;
      background: linear-gradient(90deg, var(--text-1) 20%, color-mix(in srgb, var(--accent) 85%, var(--text-1)));
      -webkit-background-clip: text; background-clip: text; color: transparent; }
    .tagline { font-size: 12px; color: var(--text-3); }
    /* Entreprise (page Personnalisation) : logo et nom centrés, « propulsé par Wolflog » discret, message d'accueil. */
    .head { display: grid; gap: 14px; }
    .brand.company { flex-direction: column; gap: 10px; margin-bottom: 0; text-align: center; }
    .brand.company .titles { justify-items: center; gap: 4px; }
    .company-logo { display: grid; place-items: center; max-width: 100%; animation: company-in .7s var(--spring) .15s backwards; }
    /* Hauteur fixe, largeur tirée des proportions : un SVG sans dimensions (viewBox seul) ne s'écrase pas ; jamais agrandi. */
    .company-logo img { display: block; height: 64px; width: auto; max-width: min(240px, 100%); object-fit: scale-down; }
    @keyframes company-in { from { opacity: 0; transform: translateY(8px) scale(.85); } }
    .company-name { font: 700 22px/1.2 var(--sans); letter-spacing: -.02em; overflow-wrap: anywhere; }
    .powered { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--text-3); }
    .welcome { margin: 0; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.55; color: var(--text-2);
      text-align: center; white-space: pre-line; overflow-wrap: anywhere;
      background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); }

    form { display: grid; gap: 14px; }
    .field { display: grid; gap: 6px; font-size: 12px; font-weight: 550; color: var(--text-2); }
    .field:focus-within { color: var(--accent); }
    .control { position: relative; display: block; }
    .control input { width: 100%; height: 40px; padding-left: 36px; font-size: 13.5px; }
    .control input.with-toggle { padding-right: 42px; }
    .control input:focus { transform: none; }
    .lead { position: absolute; left: 12px; top: 0; bottom: 0; margin: auto 0; height: 15px; color: var(--text-3); pointer-events: none;
      transition: color .25s, transform .4s var(--spring); }
    .control:focus-within .lead { color: var(--accent); transform: scale(1.12) rotate(-6deg); }
    /* Afficher / masquer : un trait barre l'œil quand le mot de passe est visible. */
    .reveal { position: absolute; right: 5px; top: 0; bottom: 0; margin: auto 0; width: 30px; height: 30px; display: grid; place-items: center;
      border: 0; border-radius: 9px; background: none; color: var(--text-3); cursor: pointer;
      transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .reveal:hover { color: var(--text-1); background-color: var(--surface-3); }
    .reveal:active { transform: scale(.88); }
    .reveal.on { color: var(--accent); }
    .reveal::after { content: ''; position: absolute; width: 19px; height: 1.8px; border-radius: 2px; background: currentColor;
      transform: rotate(-45deg) scaleX(0); transition: transform .35s var(--spring); }
    .reveal.on::after { transform: rotate(-45deg) scaleX(1); }

    /* Sous le mot de passe : une ligne toujours réservée ; le message apparaît en fondu, sans mouvement ni saut. */
    .msg { display: flex; align-items: flex-start; gap: 7px; min-height: 18px; margin-top: -6px; font-size: 12.5px; line-height: 18px; }
    .msg.err { color: var(--danger); }
    .msg.caps { color: var(--warn); font-weight: 550; }
    .msg wl-nav-icon { flex: none; margin-top: 2px; }
    .msg > * { animation: msg-in .2s ease-out; }
    @keyframes msg-in { from { opacity: 0; } }
    .control input[aria-invalid='true'] { border-color: color-mix(in srgb, var(--danger) 60%, var(--border)); }
    .error { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.45; padding: 9px 12px; border-radius: var(--radius-sm); color: var(--danger);
      background: color-mix(in srgb, var(--danger) 11%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
    .error wl-nav-icon { margin-top: 1px; }
    .hint-in { animation: hint-in .4s var(--spring); }
    .hint-out { animation: hint-out .18s ease-in forwards; }
    @keyframes hint-in { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
    @keyframes hint-out { to { opacity: 0; transform: translateY(-4px); } }

    .btn { justify-content: center; height: 40px; font-size: 13.5px; }
    .sso { gap: 8px; }
    /* Connexion unique : bouton Microsoft sobre (le logo garde ses couleurs), bouton Windows en verre. */
    .methods { display: grid; gap: 10px; }
    .btn.ms, .btn.win { gap: 10px; font-weight: 600; }
    .btn.ms { color: var(--text-1); background: var(--surface-solid); border-color: var(--border); }
    .btn.ms:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
    .btn.ms wl-microsoft-logo, .btn.win wl-nav-icon { transition: transform .4s var(--spring); }
    .btn.ms:hover wl-microsoft-logo { transform: scale(1.08) rotate(-4deg); }
    .btn.win wl-nav-icon { color: var(--accent); }
    .btn.win:hover wl-nav-icon { transform: scale(1.1); }
    /* Connexion automatique : l'anneau tourne tant que la redirection est en cours (attente réelle). */
    .auto { display: grid; justify-items: center; gap: 6px; padding: 8px 0 2px; text-align: center; }
    .auto-mark { position: relative; display: grid; place-items: center; width: 54px; height: 54px; margin-bottom: 6px; border-radius: 50%;
      background: var(--surface-2); border: 1px solid var(--border-soft); }
    .auto-mark wl-nav-icon { color: var(--accent); }
    .auto-ring { position: absolute; inset: -5px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--accent);
      border-right-color: color-mix(in srgb, var(--accent) 45%, transparent); animation: spin .9s linear infinite; }
    .auto strong { font-size: 14.5px; font-weight: 650; }
    .auto-hint { font-size: 12px; color: var(--text-3); }
    .auto-cancel { margin-top: 6px; padding: 5px 10px; border: 0; border-radius: 9px; background: none; color: var(--accent); cursor: pointer;
      font: 550 12.5px var(--sans); transition: background-color .2s, color .2s; }
    .auto-cancel:hover { background-color: var(--accent-soft); color: var(--text-1); }
    .away { display: none; }
    .field-hint { font-size: 11.5px; font-weight: 400; color: var(--text-3); }
    .submit { gap: 8px; margin-top: 2px; }
    .submit.busy:disabled { opacity: .85; }
    .go { transition: transform .35s var(--spring); }
    .submit:hover .go { transform: translateX(4px); }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .or { display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--text-3); }
    .or::before, .or::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--border), transparent); }
    .hint { display: flex; gap: 8px; margin: 2px 0 0; padding-top: 14px; border-top: 1px solid var(--border-soft); font-size: 12px; line-height: 1.5; color: var(--text-3); }
    .hint wl-nav-icon { margin-top: 2px; color: var(--accent); }
  `,
})
export class LoginPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  /** Nom, logo et message d'accueil de l'entreprise (en-tête de la carte). */
  protected readonly branding = inject(Branding);
  readonly returnUrl = input<string>('/');
  readonly ssoParam = input<string>('', { alias: 'sso' });
  /** /login?local=1 : formulaire local, sans connexion automatique. */
  readonly local = input<string>('');
  protected readonly me = signal<Me | null>(null);
  /** Connexion automatique en cours (vers Microsoft ou Windows), annulable un instant. */
  protected readonly redirecting = signal<'microsoft' | 'windows' | null>(null);
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  /** Annuaire de l'entreprise activé : exemple d'identifiant sous le champ (vide sinon). */
  protected readonly ldapHint = computed(() => {
    const sso = this.me()?.sso;
    if (!sso?.ldap) return '';
    return sso.ldapDomain ? `ex. jdupont ou jdupont@${sso.ldapDomain} ou votre compte Wolflog` : 'ex. jdupont  ou votre compte Wolflog';
  });
  /** Retour d'une connexion unique en échec (/login?sso=…). */
  protected readonly ssoMessage = computed(() => {
    const reason = this.ssoParam();
    if (!reason) return '';
    const name = this.me()?.sso?.name ?? 'Microsoft';
    return (SSO_ERRORS[reason] ?? SSO_ERRORS['error']).replace('{name}', name);
  });
  protected username = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** Mot de passe affiché en clair. */
  protected readonly reveal = signal(false);
  /** Verrouillage des majuscules actif pendant la saisie du mot de passe. */
  protected readonly capsLock = signal(false);
  private readonly passwordBox = viewChild.required<ElementRef<HTMLInputElement>>('passwordBox');

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.autoTimer));
    this.api.me().subscribe({
      next: (me) => {
        if (me.authenticated) {
          this.session.me.set(me);
          this.router.navigateByUrl(this.returnUrl() || '/');
        } else {
          this.autoSignIn(me);
        }
        this.me.set(me);
      },
      error: () => {},
    });
  }

  protected ssoUrl() {
    return '/api/auth/sso?returnUrl=' + encodeURIComponent(this.returnUrl() || '/');
  }

  protected windowsUrl() {
    return '/api/auth/windows?returnUrl=' + encodeURIComponent(this.returnUrl() || '/');
  }

  /**
   * Connexion automatique réglée par l'administrateur : départ vers Microsoft (ou Windows) après un court instant, le
   * temps d'annuler. Jamais après un échec (?sso=…), qui bouclerait, ni avec /login?local=1.
   */
  private autoSignIn(me: Me) {
    const target = me.sso?.autoRedirect;
    if (!target || this.local() || this.ssoParam()) return;
    this.redirecting.set(target);
    this.autoTimer = setTimeout(() => location.assign(target === 'windows' ? this.windowsUrl() : this.ssoUrl()), 900);
  }

  /** Annulation : formulaire et boutons ; ?local=1 dans l'adresse pour qu'un rechargement ne reparte pas. */
  protected cancelAuto() {
    clearTimeout(this.autoTimer);
    this.redirecting.set(null);
    this.router.navigate([], { queryParams: { local: 1 }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  submit() {
    this.busy.set(true);
    this.api.login(this.username, this.password).subscribe({
      next: async () => {
        const me = await this.session.load();
        this.router.navigateByUrl(me.mustChangePassword ? '/account?first=1' : this.returnUrl() || '/');
      },
      error: (e) => {
        this.busy.set(false);
        // Message du serveur : identifiants refusés, mot de passe à changer, compte verrouillé, annuaire injoignable…
        this.error.set(e?.error?.error ?? 'Identifiant ou mot de passe incorrect.');
        // Mot de passe sélectionné : il suffit de le retaper.
        const box = this.passwordBox().nativeElement;
        box.focus();
        box.select();
      },
    });
  }

  protected checkCaps(e: KeyboardEvent) {
    this.capsLock.set(e.getModifierState?.('CapsLock') ?? false);
  }

}
