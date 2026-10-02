import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { PROFILE_ICONS, effectiveProfile, profileSummary, profileTone, servicesLabel } from '../core/access';
import { AccessProfile, Role, UserAccount } from '../core/models';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { CopyText } from '../shared/copy-text';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { ServicePicker } from '../shared/service-picker';
import { Skeleton } from '../shared/skeleton';

/** Services visibles d'un compte : ceux de son profil, tous, ou une liste propre. */
type ScopeMode = 'profile' | 'all' | 'custom';

/** Rôles : libellé, explication, icône et teinte (listes déroulantes, pastilles, cartes de choix). */
export const ROLE_LABELS: Record<Role, { label: string; hint: string; icon: string; tone: string }> = {
  viewer: { label: 'Lecteur', hint: 'Consulte, ne modifie rien', icon: 'eye', tone: 'var(--accent-3)' },
  editor: { label: 'Éditeur', hint: 'Tableaux de bord, statut des erreurs, alertes, recherches partagées', icon: 'pencil', tone: 'var(--accent)' },
  admin: { label: 'Administrateur', hint: 'Tout, plus les utilisateurs, clés API, sources et sauvegardes', icon: 'crown', tone: 'var(--warn)' },
};

/** Initiales d'une personne : « Jeanne Dupont » → « JD », « jdupont » → « JD ». */
export function nameInitials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Teinte stable dérivée du nom : même personne, même couleur (même calcul que les avatars des listes déroulantes). */
export function nameHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Date complète pour les infobulles : « mercredi 1 octobre 2026 à 14:32 ». */
function exactDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) : '';
}

/**
 * Comptes : rôle (ce qu'on peut faire), profil d'accès et services visibles (ce qu'on voit) modifiables dans la liste,
 * filtre par accès (?profile=<id> ou ?role=admin), mot de passe provisoire, désactivation et suppression.
 */
@Component({
  selector: 'wl-admin-users',
  imports: [RouterLink, AgoPipe, CopyText, NavIcon, RichOption, ServicePicker, Skeleton],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Utilisateurs</h1>
        @if (loaded()) {
          <span class="u-count">{{ users().length }} compte{{ users().length > 1 ? 's' : '' }}</span>
          @if (disabledCount()) { <span class="u-count muted">{{ disabledCount() }} désactivé{{ disabledCount() > 1 ? 's' : '' }}</span> }
        }
        <span class="spacer"></span>
        <a class="btn" routerLink="/admin/access"><wl-nav-icon name="id-card" [size]="14" />Profils d'accès</a>
        <a class="btn primary" routerLink="/admin/users/new" [queryParams]="profile() && !role() ? { profile: profile() } : {}"><wl-nav-icon name="plus" />Ajouter un utilisateur</a>
      </div>

      @if (secret(); as s) {
        <div class="panel secret" animate.leave="slide-out" role="status">
          <span class="secret-icon"><wl-nav-icon name="lock" [size]="18" /></span>
          <div class="secret-body">
            <div>Mot de passe provisoire de <strong>{{ s.user }}</strong></div>
            <div class="secret-value"><code>{{ s.password }}</code><wl-copy [text]="s.password" /></div>
            <div class="muted small">Transmettez-le à la personne : il ne sera plus affiché. Elle devra le changer à la première connexion.</div>
          </div>
          <button class="btn ghost icon" (click)="secret.set(null)" title="Fermer" aria-label="Fermer"><wl-nav-icon name="close" /></button>
        </div>
      }

      @if (error()) {
        <div class="alert" role="alert" animate.leave="slide-out">
          <wl-nav-icon name="warning" [size]="15" /><span>{{ error() }}</span>
          <button class="btn ghost icon" (click)="error.set('')" title="Fermer" aria-label="Fermer"><wl-nav-icon name="close" [size]="14" /></button>
        </div>
      }

      @if (loaded() && users().length > 1) {
        <div class="access-filters" role="group" aria-label="Filtrer par accès">
          <button type="button" class="access-filter" [class.on]="!role() && !profile()" (click)="filterBy(null, null)" style="--tone: var(--accent)">
            <wl-nav-icon name="users" [size]="13" />Tous<b>{{ users().length }}</b>
          </button>
          <button type="button" class="access-filter" [class.on]="role() === 'admin'" (click)="filterBy('admin', null)" [style.--tone]="roleLabels.admin.tone"
                  title="Les administrateurs voient tout, quel que soit leur profil">
            <wl-nav-icon name="crown" [size]="13" />Administrateurs<b>{{ adminCount() }}</b>
          </button>
          @for (p of profiles(); track p.id) {
            <button type="button" class="access-filter" [class.on]="!role() && profile() === p.id" (click)="filterBy(null, p.id)" [style.--tone]="tone(p.id)" [title]="summary(p)">
              <wl-nav-icon [name]="p.icon || defaultIcon" [size]="13" />{{ p.name }}<b>{{ countFor(p.id) }}</b>
            </button>
          }
        </div>
      }

      <section class="panel">
        @if (!loaded()) {
          <wl-skeleton [rows]="4" />
        } @else if (shown().length) {
          <table class="list">
            <thead><tr><th>Utilisateur</th><th>Rôle</th><th>Accès</th><th>Services</th><th>Connexion</th><th>Dernière connexion</th><th>État</th><th><span class="sr">Actions</span></th></tr></thead>
            <tbody>
              @for (u of shown(); track u.id) {
                <tr [class.off]="u.disabled">
                  <td class="person">
                    <div class="user">
                      <span class="avatar" [style.--hue]="hue(u.username)" aria-hidden="true">{{ initials(u.displayName || u.username) }}</span>
                      <div class="who">
                        <div class="name"><span class="ellipsis">{{ u.displayName || u.username }}</span>@if (u.id === meId()) { <span class="you">vous</span> }</div>
                        <div class="muted small mono ellipsis" [title]="u.username + (u.email ? ' · ' + u.email : '')">{{ u.username }}{{ u.email ? ' · ' + u.email : '' }}</div>
                      </div>
                    </div>
                  </td>
                  <td class="role">
                    <select class="tinted" [style.--tone]="roleLabels[u.role].tone" (change)="update(u, { role: $any($event.target).value })" [title]="roleLabels[u.role].hint" aria-label="Rôle">
                      @for (r of roles; track r) {
                        <option [value]="r" [selected]="r === u.role" [wlOpt]="roleLabels[r].label" [icon]="roleLabels[r].icon" [tone]="roleLabels[r].tone"
                                [desc]="roleLabels[r].hint"></option>
                      }
                    </select>
                  </td>
                  <td class="access">
                    @if (u.role === 'admin') {
                      <span class="p-badge" [style.--tone]="roleLabels.admin.tone" title="Les administrateurs voient tout, quel que soit leur profil">
                        <wl-nav-icon name="crown" [size]="12" />Administrateur : tout
                      </span>
                    } @else if (profilesLoaded()) {
                      <select class="tinted" [style.--tone]="known(u) ? tone(effective(u)) : 'var(--danger)'" (change)="update(u, { profileId: $any($event.target).value })"
                              [title]="accessHint(u)" aria-label="Profil d'accès">
                        @if (!known(u)) {
                          <option [value]="effective(u)" selected wlOpt="Profil introuvable" icon="warning" tone="danger" desc="Aucune partie visible : choisissez un profil"></option>
                        }
                        @for (p of profiles(); track p.id) {
                          <option [value]="p.id" [selected]="p.id === effective(u)" [wlOpt]="p.name" [icon]="p.icon || defaultIcon" [tone]="tone(p.id)" [desc]="summary(p)"></option>
                        }
                      </select>
                    } @else {
                      <i class="skeleton select-ghost" aria-busy="true"></i>
                    }
                  </td>
                  <td class="services">
                    @if (u.role === 'admin') {
                      <span class="scope" title="Les administrateurs voient tous les services"><wl-nav-icon name="layers" [size]="12" /><span class="ellipsis">Tous</span></span>
                    } @else {
                      <button type="button" class="scope edit" [class.limited]="scopeOf(u).length > 0" [class.own]="u.services != null" (click)="editServices(u)"
                              [attr.aria-expanded]="servicesFor() === u.id" [title]="scopeHint(u)">
                        <wl-nav-icon [name]="scopeOf(u).length ? 'filter' : 'layers'" [size]="12" />
                        <span class="ellipsis">{{ scopeText(u) }}</span>
                        <wl-nav-icon name="edit" [size]="11" class="scope-pen" />
                      </button>
                    }
                  </td>
                  <td class="source">
                    <span class="p-badge" [style.--tone]="u.source === 'sso' ? 'var(--accent-3)' : u.source === 'ldap' ? 'var(--accent)' : 'var(--text-3)'">
                      <wl-nav-icon [name]="u.source === 'sso' ? 'shield' : u.source === 'ldap' ? 'building' : 'lock'" [size]="12" />{{ u.source === 'sso' ? 'SSO' : u.source === 'ldap' ? 'Annuaire' : 'Mot de passe' }}
                    </span>
                    @if (u.mustChangePassword) {
                      <span class="p-badge" style="--tone: var(--warn)" title="Doit choisir son mot de passe à la prochaine connexion"><wl-nav-icon name="clock" [size]="12" />provisoire</span>
                    }
                  </td>
                  <td class="login small nowrap" [class.muted]="!u.lastLoginAt" [title]="exact(u.lastLoginAt)">
                    <span class="label">Dernière connexion : </span>{{ u.lastLoginAt ? (u.lastLoginAt | ago) : 'jamais' }}
                  </td>
                  <td class="status small nowrap">
                    <span class="state" [class.on]="!u.disabled"><wl-nav-icon [name]="u.disabled ? 'pause' : 'ok'" [size]="13" />{{ u.disabled ? 'Désactivé' : 'Actif' }}</span>
                  </td>
                  <td class="acts nowrap">
                    @if (confirmDelete() === u.id) {
                      <span class="confirm" animate.enter="confirm-in">
                        <span class="small">Supprimer {{ u.username }} ?</span>
                        <button class="btn danger small" (click)="remove(u)"><wl-nav-icon name="trash" [size]="13" />Supprimer</button>
                        <button class="btn ghost small" (click)="confirmDelete.set(null)">Annuler</button>
                      </span>
                    } @else {
                      <!-- Actions révélées au survol : leur place est toujours réservée (opacité seulement), rien ne bouge ni ne couvre le texte. -->
                      <span class="tools">
                        <button class="btn ghost icon" (click)="reset(u)" title="Nouveau mot de passe : génère un mot de passe provisoire"
                                aria-label="Nouveau mot de passe"><wl-nav-icon name="lock" [size]="14" /></button>
                        <button class="btn ghost icon" [class.hidden]="u.id === meId()" [disabled]="u.id === meId()" (click)="update(u, { disabled: !u.disabled })"
                                [title]="u.disabled ? 'Réactiver le compte' : 'Désactiver le compte'" [attr.aria-label]="u.disabled ? 'Réactiver' : 'Désactiver'">
                          <wl-nav-icon [name]="u.disabled ? 'play' : 'pause'" [size]="14" /></button>
                        <button class="btn ghost icon del" [class.hidden]="u.id === meId()" [disabled]="u.id === meId()" (click)="confirmDelete.set(u.id)"
                                title="Supprimer le compte" aria-label="Supprimer"><wl-nav-icon name="trash" [size]="14" /></button>
                      </span>
                    }
                  </td>
                </tr>
                @if (servicesFor() === u.id) {
                  <tr class="scope-row">
                    <td colspan="8">
                      <div class="scope-editor" animate.enter="scope-in" role="group" [attr.aria-label]="'Services visibles de ' + (u.displayName || u.username)">
                        <div class="scope-head">
                          <strong>Services visibles de {{ u.displayName || u.username }}</strong>
                          <span class="muted small">ses logs, requêtes, traces, erreurs, métriques et tableaux de bord s'arrêtent à ces services</span>
                        </div>
                        <div class="seg" role="radiogroup" aria-label="Services visibles">
                          <button type="button" role="radio" [class.on]="scopeMode() === 'profile'" [attr.aria-checked]="scopeMode() === 'profile'" (click)="scopeMode.set('profile')">Comme son profil</button>
                          <button type="button" role="radio" [class.on]="scopeMode() === 'all'" [attr.aria-checked]="scopeMode() === 'all'" (click)="scopeMode.set('all')">Tous</button>
                          <button type="button" role="radio" [class.on]="scopeMode() === 'custom'" [attr.aria-checked]="scopeMode() === 'custom'" (click)="scopeMode.set('custom')">Choisir…</button>
                        </div>
                        @switch (scopeMode()) {
                          @case ('profile') {
                            <p class="small muted">Profil « {{ profileName(u) }} » : {{ servicesText(profileServices(u)) }}.</p>
                          }
                          @case ('all') {
                            <p class="small muted">Tous les services, y compris ceux qui apparaîtront plus tard, quel que soit son profil.</p>
                          }
                          @default {
                            <wl-service-picker [(value)]="scopeDraft" />
                          }
                        }
                        <div class="scope-actions">
                          <button type="button" class="btn primary small" (click)="saveServices(u)" [disabled]="scopeMode() === 'custom' && !scopeDraft().length">
                            <wl-nav-icon name="check" [size]="13" />Enregistrer</button>
                          <button type="button" class="btn ghost small" (click)="servicesFor.set(null)">Annuler</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        } @else if (users().length) {
          <div class="empty">
            <strong>Aucun compte {{ role() === 'admin' ? 'administrateur' : 'avec ce profil' }}</strong>
            <span>Choisissez le profil d'accès d'une personne dans la colonne « Accès ».</span>
            <button class="btn" (click)="filterBy(null, null)"><wl-nav-icon name="users" [size]="14" />Tous les comptes</button>
          </div>
        } @else {
          <div class="empty">
            <strong>Aucun compte</strong>
            <span>Ajoutez les personnes qui doivent consulter ou administrer Wolflog.</span>
            <a class="btn primary" routerLink="/admin/users/new"><wl-nav-icon name="plus" />Ajouter un utilisateur</a>
          </div>
        }
      </section>

      <div class="roles">
        @for (r of roles; track r; let i = $index) {
          <div class="role-card" [style.--tone]="roleLabels[r].tone" [style.--i]="i">
            <span class="role-icon"><wl-nav-icon [name]="roleLabels[r].icon" [size]="16" /></span>
            <div><strong>{{ roleLabels[r].label }}</strong><span>{{ roleLabels[r].hint }}.</span></div>
          </div>
        }
        <a class="role-card access-card" routerLink="/admin/access" style="--tone: var(--accent-2); --i: 3">
          <span class="role-icon"><wl-nav-icon name="id-card" [size]="16" /></span>
          <div><strong>Profil d'accès</strong><span>Les parties de Wolflog visibles : à chacun la sienne (sans effet sur les administrateurs).</span></div>
          <wl-nav-icon name="chevron-right" [size]="14" class="go" />
        </a>
      </div>
      @if (session.me()?.sso; as sso) {
        <p class="sso muted small"><wl-nav-icon name="shield" [size]="14" />
          <span>Les personnes qui se connectent avec {{ sso.name }} sont ajoutées automatiquement ; leur rôle et leur profil peuvent suivre les groupes de l'annuaire
            (<a routerLink="/admin/sso">Connexion SSO</a>).</span></p>
      }
    </div>
  `,
  styles: `
    .u-count { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; font: 600 11.5px var(--sans);
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); animation: pop .45s var(--spring) backwards; }
    .u-count.muted { color: var(--text-3); }
    @keyframes pop { from { opacity: 0; transform: scale(.8); } }

    .secret { display: flex; align-items: flex-start; gap: 12px; padding: 12px 12px 12px 14px; border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
    .secret-icon { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; color: var(--ok);
      background: color-mix(in srgb, var(--ok) 15%, transparent); }
    .secret-body { flex: 1; display: grid; gap: 5px; min-width: 0; }
    .secret-value { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .secret-value code { padding: 4px 10px; font-size: 14px; border-radius: 8px; background: var(--code-bg); border: 1px solid var(--border); user-select: all;
      overflow-wrap: anywhere; }
    .alert { display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 12px; border-radius: var(--radius-sm); font-size: 12.5px; color: var(--danger);
      background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
    .alert span { flex: 1; }
    /* Entrée : animation « rise » de la page (enfants directs de .page) ; sortie : fondu vers le haut. */
    .slide-out { animation: slide-out .2s ease-in forwards; }
    @keyframes slide-out { to { opacity: 0; transform: translateY(-6px) scale(.98); } }

    /* Filtre par accès : pastilles avec le nombre de comptes ; survol : couleur seulement. */
    .access-filters { display: flex; flex-wrap: wrap; gap: 6px; }
    .access-filter { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px 0 10px; border: 1px solid var(--border-soft); border-radius: 999px;
      font: 550 12px var(--sans); color: var(--text-2); background: var(--surface-2); cursor: pointer;
      transition: color .2s, border-color .2s, background-color .2s, transform .25s var(--spring); }
    .access-filter wl-nav-icon { color: var(--tone); }
    .access-filter b { min-width: 20px; padding: 0 6px; border-radius: 999px; font: 650 11px/18px var(--mono); text-align: center; color: var(--text-2);
      background: var(--surface-3); }
    .access-filter:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--tone) 50%, var(--border)); }
    .access-filter:active { transform: scale(.95); }
    .access-filter.on { color: var(--text-1); border-color: color-mix(in srgb, var(--tone) 65%, transparent);
      background: color-mix(in srgb, var(--tone) 16%, transparent); box-shadow: inset 0 1px 0 var(--highlight); }
    .access-filter.on b { color: var(--on-accent); background: var(--tone); }

    .btn.icon { width: 28px; height: 28px; padding: 0; justify-content: center; }
    .user { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .person { max-width: 0; width: 30%; }
    .avatar { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; color: #fff; font: 700 11px/1 var(--sans);
      letter-spacing: .02em; background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%));
      box-shadow: 0 4px 10px -4px hsl(var(--hue) 70% 45% / .9), inset 0 1px 0 rgb(255 255 255 / .35); transition: transform .35s var(--spring), opacity .25s; }
    tr:hover .avatar { transform: scale(1.08) rotate(-5deg); }
    .who { display: grid; min-width: 0; }
    .name { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 550; }
    .you { flex: none; padding: 0 7px; border-radius: 999px; font: 650 10px/17px var(--sans); text-transform: uppercase; letter-spacing: .04em;
      color: var(--accent); background: var(--accent-soft); }
    /* Rôle et accès : listes en forme de pastille, teintées comme leur valeur. */
    select.tinted { width: 176px; height: 30px; border-radius: 999px; border-color: color-mix(in srgb, var(--tone) 42%, var(--border));
      background-color: color-mix(in srgb, var(--tone) 10%, var(--surface-2)); }
    .select-ghost { display: block; width: 176px; height: 30px; border-radius: 999px; }
    /* Étiquettes (connexion, administrateur) : styles complets ici, rien d'hérité. */
    .p-badge { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; margin: 1px 4px 1px 0; padding: 0 9px 0 7px;
      border-radius: 999px; font: 600 11.5px/1 var(--sans); white-space: nowrap; vertical-align: middle; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 13%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 26%, transparent); }
    .access .p-badge { height: 30px; padding: 0 12px 0 10px; }
    /* Services visibles : étiquette cliquable (liste du profil en sourdine, liste propre au compte en couleur). */
    .services { max-width: 0; width: 15%; }
    .scope { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 26px; padding: 0 9px; border: 1px solid var(--border-soft);
      border-radius: 999px; font: 550 11.5px/1 var(--mono); white-space: nowrap; color: var(--text-3); background: var(--surface-2); }
    .scope wl-nav-icon { flex: none; color: var(--ok); }
    .scope.limited { color: var(--text-1); }
    .scope.limited wl-nav-icon { color: var(--accent-3); }
    .scope.own { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); }
    .scope.edit { cursor: pointer; transition: border-color .2s, color .2s; }
    .scope.edit:hover { border-color: var(--accent); color: var(--text-1); }
    .scope-pen { color: var(--text-3) !important; opacity: .6; transition: opacity .2s; }
    .scope.edit:hover .scope-pen { opacity: 1; }
    /* Édition des services : une ligne qui s'ouvre sous le compte (au clic, jamais au survol). */
    tr.scope-row td { padding: 0 16px 14px; background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .scope-editor { display: grid; gap: 10px; max-width: 720px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--surface-2); }
    .scope-head { display: grid; gap: 2px; }
    .scope-actions { display: flex; gap: 8px; }
    .scope-in { animation: scope-in .35s var(--ease); }
    @keyframes scope-in { from { opacity: 0; transform: translateY(-6px); } }
    /* État du compte : icône et couleur du texte (pas de pastille). */
    .state { display: inline-flex; align-items: center; gap: 6px; color: var(--text-3); }
    .state.on { color: var(--ok); }
    tr.off td { color: var(--text-3); }
    tr.off .avatar { opacity: .45; }
    .login .label, .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

    .acts { text-align: right; width: 1%; }
    .tools, .confirm { display: inline-flex; align-items: center; gap: 4px; }
    /* Actions de la ligne : révélées au survol (ou au clavier) par l'opacité seule, place toujours réservée. */
    .tools { opacity: 0; transition: opacity .2s; }
    tr:hover .tools, .tools:focus-within { opacity: 1; }
    @media (hover: none) { .tools { opacity: 1; } }
    .tools .hidden { visibility: hidden; }
    .del:hover { color: var(--danger); }
    .confirm-in { animation: confirm-in .35s var(--spring); }
    @keyframes confirm-in { from { opacity: 0; transform: translateX(10px); } }

    .empty { display: grid; justify-items: center; gap: 6px; }
    .empty strong { color: var(--text-1); font-size: 14px; }
    .empty .btn { margin-top: 8px; }

    .roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 12px; }
    .role-card { position: relative; display: flex; align-items: flex-start; gap: 11px; padding: 12px 14px; border-radius: var(--radius-sm);
      border: 1px solid var(--border-soft); background: var(--surface-2); color: inherit; transition: transform .3s var(--spring), border-color .2s;
      animation: rise .45s var(--ease) backwards; animation-delay: calc(var(--i) * 60ms + 120ms); }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
    .role-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--tone) 45%, var(--border)); text-decoration: none; }
    .role-card > div { flex: 1; min-width: 0; display: grid; gap: 2px; font-size: 12px; color: var(--text-3); }
    .role-card strong { color: var(--text-1); font-size: 12.5px; }
    .role-icon { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 15%, transparent); transition: transform .4s var(--spring); }
    .role-card:hover .role-icon { transform: scale(1.1) rotate(-8deg); }
    .access-card .go { flex: none; align-self: center; color: var(--text-3); transition: transform .35s var(--spring), color .2s; }
    .access-card:hover .go { color: var(--accent); transform: translateX(3px); }
    .sso { display: flex; gap: 8px; margin: 0; }
    .sso wl-nav-icon { flex: none; margin-top: 1px; color: var(--accent-3); }
    p { margin: 0; }

    /* Écrans étroits : chaque compte devient une carte (identité, rôle et accès, connexion, actions). */
    @media (max-width: 760px) {
      .page { padding: 14px 12px 24px; gap: 14px; }
      table.list thead { display: none; }
      table.list, table.list tbody { display: block; }
      table.list tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; padding: 12px 14px;
        grid-template-areas: 'person person' 'role access' 'services services' 'source source' 'login status' 'acts acts'; border-bottom: 1px solid var(--border-soft); }
      table.list tr.scope-row { display: block; padding: 0 14px 14px; }
      table.list tr.scope-row td { padding: 0; background: none; }
      .services { grid-area: services; width: auto; max-width: none; }
      table.list tr:last-child { border-bottom: 0; }
      table.list td { display: block; padding: 0; border: 0; min-width: 0; }
      .person { grid-area: person; width: auto; max-width: none; }
      .role { grid-area: role; }
      .access { grid-area: access; }
      .source { grid-area: source; }
      .login { grid-area: login; }
      .status { grid-area: status; text-align: right; }
      .acts { grid-area: acts; width: auto; }
      .login .label { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
      select.tinted, .select-ghost, .access .p-badge { width: 100%; }
      .tools { opacity: 1; }
    }
  `,
})
export class AdminUsersPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);
  /** Filtre de la liste (adresse) : profil d'accès (?profile=<id>) ou administrateurs (?role=admin). */
  readonly profile = input<string>();
  readonly role = input<string>();

  protected readonly users = signal<UserAccount[]>([]);
  protected readonly profiles = signal<AccessProfile[]>([]);
  /** Première réponse reçue (avant : squelette). */
  protected readonly loaded = signal(false);
  protected readonly profilesLoaded = signal(false);
  protected readonly error = signal('');
  protected readonly secret = signal<{ user: string; password: string } | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly roles: Role[] = ['viewer', 'editor', 'admin'];
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly initials = nameInitials;
  protected readonly hue = nameHue;
  protected readonly exact = exactDate;
  protected readonly tone = profileTone;
  protected readonly summary = profileSummary;
  protected readonly effective = effectiveProfile;
  protected readonly defaultIcon = PROFILE_ICONS[0];
  /** Compte dont les services visibles sont en cours de modification (ligne ouverte sous lui). */
  protected readonly servicesFor = signal<string | null>(null);
  protected readonly scopeMode = signal<ScopeMode>('profile');
  protected readonly scopeDraft = signal<string[]>([]);

  private readonly byId = computed(() => new Map(this.profiles().map((p) => [p.id, p])));
  protected readonly adminCount = computed(() => this.users().filter((u) => u.role === 'admin').length);
  /** Comptes affichés : tous, les administrateurs, ou ceux d'un profil (les administrateurs n'en ont pas : ils voient tout). */
  protected readonly shown = computed(() => {
    if (this.role() === 'admin') return this.users().filter((u) => u.role === 'admin');
    const profile = this.profile();
    return profile ? this.users().filter((u) => u.role !== 'admin' && effectiveProfile(u) === profile) : this.users();
  });

  constructor() {
    this.load();
    this.api.accessProfiles().subscribe({
      next: (p) => {
        this.profiles.set(p);
        this.profilesLoaded.set(true);
      },
      error: (e) => this.fail(e),
    });
  }

  protected meId() {
    return this.users().find((u) => u.username === this.session.me()?.user)?.id;
  }

  protected disabledCount() {
    return this.users().filter((u) => u.disabled).length;
  }

  protected countFor(profileId: string) {
    return this.users().filter((u) => u.role !== 'admin' && effectiveProfile(u) === profileId).length;
  }

  /** Profil connu (sinon : supprimé ou modifié à la main, la personne ne voit plus rien). */
  protected known(u: UserAccount) {
    return this.byId().has(effectiveProfile(u));
  }

  protected accessHint(u: UserAccount) {
    const p = this.byId().get(effectiveProfile(u));
    return p ? `${p.name} : ${profileSummary(p)}` : 'Profil introuvable : choisissez un profil';
  }

  protected filterBy(role: 'admin' | null, profile: string | null) {
    this.router.navigate([], { queryParams: { role, profile }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected profileName(u: UserAccount) {
    return this.byId().get(effectiveProfile(u))?.name ?? 'Profil introuvable';
  }

  protected profileServices(u: UserAccount) {
    return this.byId().get(effectiveProfile(u))?.services ?? [];
  }

  /** Services visibles du compte : sa liste propre (vide = tous), sinon ceux de son profil. */
  protected scopeOf(u: UserAccount): readonly string[] {
    return u.services ?? this.profileServices(u);
  }

  protected scopeText(u: UserAccount) {
    return this.scopeOf(u).length ? servicesLabel(this.scopeOf(u), 2) : 'Tous';
  }

  protected scopeHint(u: UserAccount) {
    const list = this.scopeOf(u).length ? servicesLabel(this.scopeOf(u), 8) : 'tous les services';
    return (u.services != null ? `Liste propre au compte : ${list}` : `Services du profil « ${this.profileName(u)} » : ${list}`) + '\nCliquer pour modifier';
  }

  protected servicesText(patterns: readonly string[]) {
    return patterns.length ? servicesLabel(patterns, 6) : 'tous les services';
  }

  /** Ouvre (ou referme) la ligne des services visibles d'un compte. */
  protected editServices(u: UserAccount) {
    if (this.servicesFor() === u.id) {
      this.servicesFor.set(null);
      return;
    }
    this.scopeMode.set(u.services == null ? 'profile' : u.services.length ? 'custom' : 'all');
    this.scopeDraft.set([...(u.services ?? this.profileServices(u))]);
    this.servicesFor.set(u.id);
  }

  protected saveServices(u: UserAccount) {
    const mode = this.scopeMode();
    const change = mode === 'profile' ? { inheritServices: true } : { services: mode === 'all' ? [] : this.scopeDraft() };
    const name = u.displayName || u.username;
    this.api.updateUser(u.id, change).subscribe({
      next: () => {
        this.toasts.ok(mode === 'profile' ? `${name} voit les services de son profil` : mode === 'all' ? `${name} voit tous les services`
          : `Services de ${name} : ${servicesLabel(this.scopeDraft(), 3)}`, 'filter');
        this.servicesFor.set(null);
        this.load();
      },
      error: this.fail,
    });
  }

  private load() {
    this.api.users().subscribe({
      next: (u) => {
        this.users.set(u);
        this.loaded.set(true);
      },
      error: (e) => {
        this.loaded.set(true);
        this.fail(e);
      },
    });
  }

  private fail = (e: { error?: { error?: string } }) => {
    this.error.set(e?.error?.error ?? 'Opération impossible.');
    this.toasts.error(this.error());
  };

  protected update(u: UserAccount, change: Partial<{ role: Role; disabled: boolean; profileId: string }>) {
    this.error.set('');
    const name = u.displayName || u.username;
    this.api.updateUser(u.id, change).subscribe({
      next: () => {
        if (change.role) this.toasts.ok(`${name} est maintenant ${ROLE_LABELS[change.role].label.toLowerCase()}`, ROLE_LABELS[change.role].icon);
        else if (change.disabled !== undefined) this.toasts.ok(change.disabled ? `Compte de ${name} désactivé` : `Compte de ${name} réactivé`, change.disabled ? 'pause' : 'play');
        else if (change.profileId !== undefined) {
          const p = this.byId().get(change.profileId);
          this.toasts.ok(`Accès de ${name} : « ${p?.name ?? change.profileId} »`, p?.icon || PROFILE_ICONS[0]);
        }
        this.load();
      },
      error: (e) => {
        this.fail(e);
        this.load();
      },
    });
  }

  protected reset(u: UserAccount) {
    this.error.set('');
    this.api.resetPassword(u.id).subscribe({
      next: (r) => {
        this.secret.set({ user: u.username, password: r.temporaryPassword });
        this.toasts.ok(`Mot de passe provisoire généré pour ${u.username}`, 'lock');
        this.load();
      },
      error: this.fail,
    });
  }

  protected remove(u: UserAccount) {
    this.confirmDelete.set(null);
    this.api.deleteUser(u.id).subscribe({
      next: () => {
        this.toasts.ok(`Utilisateur ${u.username} supprimé`, 'trash');
        this.load();
      },
      error: this.fail,
    });
  }
}
