import { Component, computed, inject, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { servicesLabel } from '../core/access';
import { NavIcon } from './nav-icon';
import { PreferencesPanel } from './preferences-panel';
import { initials } from './rich-option';

const ROLES: Record<string, string> = { admin: 'Administrateur', editor: 'Éditeur', viewer: 'Lecteur' };

/**
 * Espace utilisateur (barre du haut) : avatar qui ouvre « Mon compte et mes préférences » 
 * identité, réglages d'affichage, compte, raccourcis clavier et déconnexion.
 */
@Component({
  selector: 'wl-user-menu',
  imports: [RouterLink, NavIcon, PreferencesPanel],
  host: { '(document:pointerdown)': 'outside($event)', '(document:keydown.escape)': 'escape($event)' },
  template: `
    <button type="button" class="me-btn" [class.on]="open()" (click)="open.set(!open())" aria-haspopup="dialog" [attr.aria-expanded]="open()"
            title="Mon compte et mes préférences" aria-label="Mon compte et mes préférences">
      <span class="avatar">
        @if (local()) { <wl-nav-icon name="account" [size]="15" /> } @else { {{ initialsOf() }} }
      </span>
    </button>
    @if (open()) {
      <div class="menu" role="dialog" aria-label="Mon compte et mes préférences" animate.enter="menu-in" animate.leave="menu-out">
        <div class="who">
          <span class="avatar big">
            @if (local()) { <wl-nav-icon name="account" [size]="18" /> } @else { {{ initialsOf() }} }
          </span>
          <div class="who-text">
            <strong class="ellipsis" [title]="name()">{{ name() }}</strong>
            <span class="small muted ellipsis">{{ subtitle() }}</span>
          </div>
        </div>
        @if (session.services(); as scope) {
          <p class="scope small" [title]="'Services visibles : ' + scope.join(', ')"><wl-nav-icon name="filter" [size]="13" /><span>Services visibles : {{ scopeLabel(scope) }}</span></p>
        }
        <div class="sec">Mes préférences</div>
        <wl-preferences-panel compact />
        <div class="links">
          @if (!local()) {
            <a routerLink="/account" (click)="open.set(false)"><wl-nav-icon name="account" [size]="14" />Mon compte<span class="hint">profil, mot de passe</span></a>
          }
          <button type="button" (click)="open.set(false); help.emit()"><wl-nav-icon name="info" [size]="14" />Raccourcis clavier<kbd>?</kbd></button>
        </div>
        @if (!local()) {
          <button type="button" class="logout" (click)="logout()" [disabled]="leaving()">
            @if (leaving()) { <span class="spinner"></span> } @else { <wl-nav-icon name="logout" [size]="14" /> }
            Se déconnecter
          </button>
        } @else {
          <p class="local small muted"><wl-nav-icon name="info" [size]="13" />Connexion désactivée sur ce serveur : accès local, sans compte.</p>
        }
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; flex: none; }
    .me-btn { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid var(--border); border-radius: 50%;
      background: var(--surface-2); cursor: pointer; transition: border-color .2s, transform .3s var(--spring); }
    .me-btn:hover, .me-btn.on { border-color: var(--accent); }
    .me-btn:active { transform: scale(.94); }
    .avatar { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; color: #fff; font: 700 10px/1 var(--sans);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .avatar.big { width: 40px; height: 40px; font-size: 14px; flex: none; }
    .menu { position: absolute; z-index: 70; top: calc(100% + 10px); right: 0; width: 340px; max-width: calc(100vw - 20px); max-height: calc(100dvh - 90px);
      overflow: auto; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius);
      background: linear-gradient(var(--surface-solid), var(--surface-solid)), var(--bg);
      backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); box-shadow: var(--shadow-pop); transform-origin: top right; }
    .menu-in { animation: menu-in .22s var(--ease); }
    .menu-out { animation: menu-out .15s ease-in forwards; }
    @keyframes menu-in { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
    @keyframes menu-out { to { opacity: 0; transform: translateY(-4px) scale(.98); } }
    .who { display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border-soft); }
    .who-text { display: grid; min-width: 0; }
    .who-text strong { font-size: 14px; }
    .scope { display: flex; align-items: center; gap: 7px; min-width: 0; margin: 10px 0 0; color: var(--text-2); }
    .scope wl-nav-icon { flex: none; color: var(--accent-3); }
    .scope span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sec { margin: 12px 0 2px; font: 650 11px var(--sans); color: var(--text-3); text-transform: uppercase; letter-spacing: .08em; }
    .links { display: grid; gap: 2px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-soft); }
    .links > * { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px; border: 0; border-radius: 10px; background: none;
      color: var(--text-1); font: 500 13px var(--sans); text-align: left; cursor: pointer; text-decoration: none; }
    .links > *:hover { background: var(--surface-3); text-decoration: none; }
    .links wl-nav-icon { color: var(--text-3); }
    .links .hint, .links kbd { margin-left: auto; }
    .links .hint { font-size: 11.5px; color: var(--text-3); }
    .logout { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 36px; margin-top: 10px; border: 1px solid var(--border);
      border-radius: 10px; background: none; color: var(--text-1); font: 600 13px var(--sans); cursor: pointer; transition: color .2s, border-color .2s, background-color .2s; }
    .logout:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
      background: color-mix(in srgb, var(--danger) 8%, transparent); }
    .local { display: flex; align-items: flex-start; gap: 7px; margin: 10px 0 0; }
    .local wl-nav-icon { margin-top: 1px; flex: none; }
  `,
})
export class UserMenu {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);
  /** Demande l'aide des raccourcis clavier (affichée par la coque de l'application). */
  readonly help = output<void>();

  protected readonly open = signal(false);
  protected readonly leaving = signal(false);
  /** Authentification désactivée sur ce serveur : pas de compte, pas de déconnexion. */
  protected readonly local = computed(() => !this.session.me()?.authEnabled);
  protected readonly name = computed(() => {
    const me = this.session.me();
    return this.local() ? 'Accès local' : me?.displayName || me?.user || 'Compte';
  });
  protected readonly subtitle = computed(() => {
    const me = this.session.me();
    if (this.local()) return 'Toutes les parties, sans connexion';
    const parts = [ROLES[me?.role ?? ''] ?? me?.role ?? ''];
    if (me?.profile?.name && me.role !== 'admin') parts.push(me.profile.name);
    if (me?.source === 'sso') parts.push(`compte ${me.sso?.name ?? 'SSO'}`);
    return parts.filter(Boolean).join(' · ');
  });
  protected readonly initialsOf = computed(() => initials(this.name()));

  /** Services visibles (profil d'accès) : les premiers, puis « et n autres ». */
  protected scopeLabel(patterns: readonly string[]) {
    return servicesLabel(patterns, 3);
  }

  /** Un clic hors du menu le ferme. */
  protected outside(e: PointerEvent) {
    if (this.open() && !(e.target as Element | null)?.closest?.('wl-user-menu')) this.open.set(false);
  }

  protected escape(e: Event) {
    try { if ((e.target as Element | null)?.matches?.('select:open')) return; } catch { /* :open inconnu */ }
    this.open.set(false);
  }

  protected logout() {
    this.leaving.set(true);
    this.api.logout().subscribe({
      next: () => {
        this.open.set(false);
        this.leaving.set(false);
        this.session.me.set(null);
        this.router.navigate(['/login']);
      },
      error: () => this.leaving.set(false),
    });
  }
}
