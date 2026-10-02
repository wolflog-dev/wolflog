import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { EVERYTHING, PROFILE_ICONS, SECTIONS, SECTION_CATEGORIES, SectionCategory, profileTone, sectionInfo, servicesLabel } from '../core/access';
import { AccessProfile } from '../core/models';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { Logo } from '../shared/logo';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { ServicePicker } from '../shared/service-picker';

/**
 * Profils d'accès : les parties de Wolflog et les services que voit chaque profil (le rôle, lui, dit ce qu'on peut y faire).
 * Cartes des profils ; création et modification sur la même page (?edit=<id> ou « new ») avec l'aperçu de la navigation.
 */
@Component({
  selector: 'wl-admin-access',
  imports: [FormsModule, RouterLink, Logo, NavIcon, RichOption, ServicePicker],
  template: `
    <div class="page" [class.form-page]="editing()">
      @if (!editing()) {
        <div class="page-head">
          <h1>Profils d'accès</h1>
          @if (loaded() && profiles().length) { <span class="p-count" title="Nombre de profils">{{ profiles().length }}</span> }
          <span class="spacer"></span>
          <a class="btn primary new-btn" [routerLink]="[]" [queryParams]="{ edit: 'new' }" queryParamsHandling="merge"><wl-nav-icon name="plus" [size]="14" />Nouveau profil</a>
        </div>

        <div class="explain">
          <div class="ex" style="--tone: var(--accent); --i: 0">
            <span class="ex-icon"><wl-nav-icon name="pencil" [size]="15" /></span>
            <p><strong>Le rôle</strong> dit ce qu'une personne peut <em>faire</em> : consulter, modifier ou administrer.</p>
          </div>
          <div class="ex" style="--tone: var(--accent-3); --i: 1">
            <span class="ex-icon"><wl-nav-icon name="eye" [size]="15" /></span>
            <p><strong>Le profil d'accès</strong> dit ce qu'elle peut <em>voir</em> : les parties de Wolflog de sa navigation.</p>
          </div>
          <div class="ex" style="--tone: var(--warn); --i: 2">
            <span class="ex-icon"><wl-nav-icon name="crown" [size]="15" /></span>
            <p><strong>Les administrateurs</strong> voient tout, quel que soit leur profil.</p>
          </div>
        </div>
        @if (session.me()?.authEnabled === false) {
          <p class="off-note" role="note"><wl-nav-icon name="warning" [size]="14" />
            <span>Authentification désactivée (<code>Wolflog:Auth:Enabled</code>) : tout le monde voit tout ; les profils s'appliqueront une fois l'authentification activée.</span></p>
        }

        @if (!loaded()) {
          <div class="cards" aria-busy="true">
            @for (g of ghosts; track $index; let i = $index) {
              <div class="panel card ghost" [style.--i]="i">
                <div class="head"><i class="skeleton p-tile-ghost"></i><div class="title"><i class="skeleton" style="width: 55%; height: 13px"></i><i class="skeleton" style="width: 80%; height: 10px"></i></div></div>
                <i class="skeleton" style="width: 90%; height: 10px"></i>
                <div class="sec-chips"><i class="skeleton sec-chip-ghost"></i><i class="skeleton sec-chip-ghost"></i><i class="skeleton sec-chip-ghost"></i></div>
              </div>
            }
          </div>
        } @else if (failed()) {
          <div class="panel empty">
            <p>Impossible de lire les profils d'accès.</p>
            <button class="btn" (click)="load()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button>
          </div>
        } @else {
          <div class="cards">
            @for (p of profiles(); track p.id; let i = $index) {
              <article class="panel card" [style.--tone]="tone(p.id)" [style.--i]="i" animate.leave="card-out">
                <div class="head">
                  <span class="p-tile"><wl-nav-icon [name]="p.icon || defaultIcon" [size]="20" /></span>
                  <div class="title">
                    <strong class="ellipsis" [title]="p.name">{{ p.name }}</strong>
                    <span class="sub ellipsis">{{ scope(p) }} · accueil : {{ homeLabel(p) }}</span>
                  </div>
                  @if (p.builtin) { <span class="p-badge" title="Fourni par Wolflog : modifiable, jamais supprimé"><wl-nav-icon name="lock" [size]="11" />Fourni</span> }
                </div>
                <p class="desc" [class.none]="!p.description" [title]="p.description ?? ''">{{ p.description || 'Sans description' }}</p>
                @if (p.id === everything) {
                  <div class="everything"><wl-nav-icon name="sparkles" [size]="14" />Toutes les parties, y compris celles des prochaines versions</div>
                } @else {
                  <div class="sec-chips">
                    @for (s of sectionsOf(p); track s.id) {
                      <span class="sec-chip" [class.home]="s.id === p.home" [title]="(s.id === p.home ? 'Page d’accueil · ' : '') + s.desc">
                        <wl-nav-icon [name]="s.id === p.home ? 'home' : s.icon" [size]="12" />{{ s.label }}
                      </span>
                    }
                  </div>
                }
                <div class="svc-line" [class.limited]="!!p.services?.length" [title]="p.services?.length ? 'Services visibles : ' + p.services!.join(', ') : 'Tous les services, y compris ceux à venir'">
                  <wl-nav-icon [name]="p.services?.length ? 'filter' : 'layers'" [size]="13" />
                  <span class="ellipsis">{{ p.services?.length ? 'Services : ' + servicesText(p.services) : 'Tous les services' }}</span>
                </div>
                <div class="foot">
                  @if (confirm() === p.id) {
                    <div class="confirm" animate.enter="confirm-in">
                      @if (p.users) {
                        <span class="small warn-text"><wl-nav-icon name="warning" [size]="13" />Attribué à {{ p.users }} utilisateur{{ p.users > 1 ? 's' : '' }}</span>
                        <a class="btn small" [routerLink]="['/admin/users']" [queryParams]="{ profile: p.id }">Réattribuer</a>
                        <button class="btn ghost small" (click)="confirm.set(null)">Fermer</button>
                      } @else {
                        <span class="small ellipsis" [title]="'Supprimer « ' + p.name + ' » ?'">Supprimer « {{ p.name }} » ?</span>
                        <button class="btn danger small" (click)="remove(p)"><wl-nav-icon name="trash" [size]="13" />Supprimer</button>
                        <button class="btn ghost small" (click)="confirm.set(null)">Annuler</button>
                      }
                    </div>
                  } @else {
                    <a class="users" [routerLink]="['/admin/users']" [queryParams]="{ profile: p.id }" title="Voir les comptes qui ont ce profil">
                      <wl-nav-icon name="users" [size]="13" /><b>{{ p.users ?? 0 }}</b>utilisateur{{ (p.users ?? 0) > 1 ? 's' : '' }}
                    </a>
                    <span class="spacer"></span>
                    <a class="btn ghost small" [routerLink]="[]" [queryParams]="{ edit: p.id }" queryParamsHandling="merge"><wl-nav-icon name="edit" [size]="13" />Modifier</a>
                    @if (!p.builtin) {
                      <button class="btn ghost small icon del" (click)="confirm.set(p.id)" [title]="'Supprimer « ' + p.name + ' »'" [attr.aria-label]="'Supprimer ' + p.name">
                        <wl-nav-icon name="trash" [size]="13" />
                      </button>
                    }
                  }
                </div>
              </article>
            }
          </div>
        }
      } @else {
        <div class="page-head">
          <a class="small crumb" [routerLink]="[]" [queryParams]="{ edit: null }" queryParamsHandling="merge"><wl-nav-icon name="id-card" [size]="14" />Profils d'accès</a>
          <span class="muted">/</span>
          <h1 class="ellipsis">{{ draftId() ? name().trim() || 'Profil sans nom' : 'Nouveau profil' }}</h1>
          <span class="spacer"></span>
          <a class="btn" [routerLink]="[]" [queryParams]="{ edit: null }" queryParamsHandling="merge">Annuler</a>
          <button class="btn primary" (click)="save()" [disabled]="!canSave()">
            @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon name="check" [size]="14" /> }{{ busy() ? 'Enregistrement…' : 'Enregistrer' }}
          </button>
        </div>

        <div class="form-grid" [style.--tone]="tone(draftId())">
          <div class="steps">
            <section class="panel step" [class.done]="!!name().trim()">
              <div class="step-head"><span class="num">1</span><h2>Quel profil ?</h2><span class="hint">le nom proposé dans la liste des utilisateurs</span></div>
              <div class="step-body">
                <div class="options">
                  <label class="field">Nom
                    <input [ngModel]="name()" (ngModelChange)="name.set($event)" maxlength="60" placeholder="ex. Support client" autocomplete="off" /></label>
                  <label class="field">Description
                    <input [ngModel]="description()" (ngModelChange)="description.set($event)" maxlength="300" placeholder="ex. Équipe support : erreurs et requêtes HTTP" autocomplete="off" /></label>
                </div>
                <div class="field">Icône
                  <div class="icon-picks" role="radiogroup" aria-label="Icône du profil">
                    @for (ic of icons; track ic) {
                      <button type="button" class="icon-pick" [class.on]="icon() === ic" role="radio" [attr.aria-checked]="icon() === ic" (click)="icon.set(ic)"
                              [attr.aria-label]="'Icône ' + ic"><wl-nav-icon [name]="ic" [size]="16" /></button>
                    }
                  </div>
                </div>
              </div>
            </section>

            <section class="panel step" [class.done]="chosen().size > 0">
              <div class="step-head"><span class="num">2</span><h2>Que peut-on y voir ?</h2>
                <span class="hint">{{ chosen().size }} partie{{ chosen().size > 1 ? 's' : '' }} sur {{ total }}</span></div>
              <div class="step-body">
                @if (isAll()) {
                  <p class="note"><wl-nav-icon name="sparkles" [size]="15" />
                    <span>« {{ name() || 'Tout voir' }} » donne accès à toutes les parties, y compris celles des prochaines versions : c'est le profil des comptes sans profil.</span></p>
                }
                @for (c of categories; track c.id) {
                  <div class="category">
                    <div class="cat-head">
                      <h3>{{ c.id }}</h3><span class="muted small">{{ c.hint }}</span><span class="spacer"></span>
                      @if (!isAll()) {
                        <button type="button" class="btn ghost small cat-all" (click)="toggleCategory(c.id)">{{ fullCategory(c.id) ? 'Tout décocher' : 'Tout cocher' }}</button>
                      }
                    </div>
                    <div class="toggles">
                      @for (s of sectionsIn(c.id); track s.id) {
                        <label class="toggle" [class.on]="chosen().has(s.id)" [class.locked]="isAll()">
                          <span class="t-icon"><wl-nav-icon [name]="s.icon" [size]="16" /></span>
                          <span class="t-text"><strong>{{ s.label }}</strong><span>{{ s.desc }}</span></span>
                          <input type="checkbox" class="switch" [checked]="chosen().has(s.id)" (change)="toggle(s.id)" [disabled]="isAll()" [attr.aria-label]="s.label" />
                        </label>
                      }
                    </div>
                  </div>
                }
              </div>
            </section>

            <section class="panel step done">
              <div class="step-head"><span class="num">3</span><h2>Quels services ?</h2><span class="hint">ses données s'arrêtent à ces services ; aucun : tous</span></div>
              <div class="step-body">
                @if (isAll()) {
                  <p class="note"><wl-nav-icon name="layers" [size]="15" />
                    <span>« {{ name() || 'Tout voir' }} » voit tous les services. Pour limiter une personne à certains services, choisissez-les sur son compte
                      (liste des utilisateurs) ou donnez-lui un autre profil.</span></p>
                } @else {
                  <wl-service-picker [(value)]="services" />
                  <p class="muted small">Logs, requêtes, traces, erreurs, métriques, audience, carte, tableaux de bord, alertes et objectifs : tout est
                    filtré sur ces services, par le serveur. Un compte peut avoir sa propre liste, qui remplace celle du profil.</p>
                }
              </div>
            </section>

            <section class="panel step" [class.done]="!!homeId()">
              <div class="step-head"><span class="num">4</span><h2>Page d'accueil</h2><span class="hint">ouverte en arrivant sur Wolflog</span></div>
              <div class="step-body">
                @if (visible().length) {
                  <select class="home-select" (change)="home.set($any($event.target).value)" aria-label="Page d'accueil">
                    @for (s of visible(); track s.id) {
                      <option [value]="s.id" [selected]="s.id === homeId()" [wlOpt]="s.label" [icon]="s.icon" [desc]="s.desc"></option>
                    }
                  </select>
                } @else {
                  <p class="muted small">Cochez d'abord les parties visibles.</p>
                }
              </div>
            </section>
          </div>

          <aside class="panel summary">
            <div class="block">
              <h3>Navigation avec ce profil</h3>
              <nav class="mini" aria-label="Aperçu de la navigation">
                <div class="mini-brand"><span class="mini-logo"><wl-logo [size]="13" /></span>wolflog</div>
                @for (g of preview(); track g.id) {
                  <div class="mini-group" animate.enter="mini-in" animate.leave="mini-out">
                    <div class="mini-section">{{ g.id }}</div>
                    @for (s of g.items; track s.id) {
                      <div class="mini-link" [class.on]="s.id === homeId()" animate.enter="mini-in" animate.leave="mini-out">
                        <wl-nav-icon [name]="s.icon" [size]="13" /><span class="ellipsis">{{ s.label }}</span>
                        @if (s.id === homeId()) { <span class="mini-home" title="Page d'accueil"><wl-nav-icon name="home" [size]="11" /></span> }
                      </div>
                    }
                  </div>
                } @empty {
                  <div class="mini-empty">Aucune partie cochée : seul « Mon compte » reste ouvert.</div>
                }
                <div class="mini-foot"><wl-nav-icon name="account" [size]="13" />Mon compte</div>
              </nav>
            </div>
            <div class="block">
              <h3>Services</h3>
              <p class="svc-line" [class.limited]="!isAll() && services().length > 0">
                <wl-nav-icon [name]="!isAll() && services().length ? 'filter' : 'layers'" [size]="13" />
                <span>{{ !isAll() && services().length ? servicesText(services(), 6) : 'Tous les services, y compris ceux à venir' }}</span>
              </p>
            </div>
            <div class="block">
              <h3>Comptes</h3>
              @if (draftId()) {
                <p class="small">
                  @if (current()?.users) {
                    Profil de <strong>{{ current()?.users }}</strong> utilisateur{{ (current()?.users ?? 0) > 1 ? 's' : '' }} :
                    les changements s'appliquent dès leur prochaine action.
                    <a [routerLink]="['/admin/users']" [queryParams]="{ profile: draftId() }">Voir</a>
                  } @else {
                    Aucun utilisateur n'a encore ce profil.
                  }
                </p>
              } @else {
                <p class="small muted">Une fois enregistré, attribuez-le depuis la liste des utilisateurs.</p>
              }
              <p class="small muted admins"><wl-nav-icon name="crown" [size]="12" />Sans effet sur les administrateurs, qui voient tout.</p>
            </div>
            @if (error()) {
              <div class="block"><span class="error small" role="alert" animate.enter="hint-in"><wl-nav-icon name="warning" [size]="14" />{{ error() }}</span></div>
            }
            <div class="actions">
              <button class="btn primary" (click)="save()" [disabled]="!canSave()">
                @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon name="check" [size]="14" /> }{{ busy() ? 'Enregistrement…' : 'Enregistrer' }}
              </button>
              <a class="btn" [routerLink]="[]" [queryParams]="{ edit: null }" queryParamsHandling="merge">Annuler</a>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  styles: `
    .p-count { display: inline-grid; place-items: center; min-width: 24px; height: 22px; padding: 0 8px; border-radius: 999px;
      font: 650 11.5px var(--mono); color: var(--accent); background: var(--accent-soft); animation: count-pop .5s var(--spring) .2s backwards; }
    @keyframes count-pop { from { opacity: 0; transform: scale(.5); } }
    .new-btn wl-nav-icon { transition: transform .4s var(--spring); }
    .new-btn:hover wl-nav-icon { transform: rotate(90deg); }

    /* Rôle, profil, administrateurs : trois rappels en verre fin. */
    .explain { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap: 10px; }
    .ex { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2);
      border: 1px solid var(--border-soft); animation: rise .45s var(--ease) backwards; animation-delay: calc(var(--i) * 60ms + 80ms); }
    .ex p { margin: 0; font-size: 12px; line-height: 1.45; color: var(--text-3); }
    .ex strong { color: var(--text-1); font-weight: 600; }
    .ex em { font-style: normal; font-weight: 600; color: var(--text-2); }
    .ex-icon { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 15%, transparent); }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
    .off-note { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 9px 12px; border-radius: var(--radius-sm); font-size: 12.5px;
      color: var(--text-2); background: color-mix(in srgb, var(--warn) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); }
    .off-note wl-nav-icon { flex: none; margin-top: 2px; color: var(--warn); }

    /* Cartes : entrée en cascade ; survol : élévation et lueur de la teinte du profil (transform et opacity). */
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(310px, 100%), 1fr)); gap: 14px; align-items: start; }
    .card { position: relative; isolation: isolate; display: grid; gap: 12px; padding: 16px 16px 12px; min-width: 0;
      animation: card-in .5s var(--ease) backwards; animation-delay: min(calc(var(--i) * 50ms), 400ms); transition: transform .4s var(--spring); }
    @keyframes card-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
    .card::before { content: ''; position: absolute; inset: -1px; z-index: -1; border-radius: inherit; pointer-events: none; opacity: 0;
      box-shadow: 0 22px 44px -22px color-mix(in srgb, var(--tone) 80%, transparent); transition: opacity .3s; }
    .card:not(.ghost):hover { transform: translateY(-3px); }
    .card:not(.ghost):hover::before { opacity: 1; }
    .card-out { animation: card-out .28s ease-in forwards; }
    @keyframes card-out { to { opacity: 0; transform: scale(.94); } }
    .head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; }
    .p-tile { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--tone), color-mix(in srgb, var(--tone) 55%, var(--accent-2)));
      box-shadow: 0 10px 22px -10px var(--tone), inset 0 1px 0 rgb(255 255 255 / .35); transition: transform .45s var(--spring); }
    .card:hover .p-tile { transform: rotate(-8deg) scale(1.08); }
    .title { display: grid; gap: 2px; min-width: 0; }
    .title strong { font-size: 14.5px; font-weight: 650; }
    .sub { font-size: 11.5px; color: var(--text-3); }
    /* « Fourni » : petite étiquette sobre (styles complets ici, rien d'hérité). */
    .p-badge { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px 0 7px; border-radius: 999px;
      font: 600 11px/1 var(--sans); white-space: nowrap; color: var(--text-2); background: var(--surface-3); box-shadow: inset 0 0 0 1px var(--border-soft); }
    .p-badge wl-nav-icon { color: var(--text-3); }
    .desc { margin: 0; min-height: 2.9em; font-size: 12.5px; line-height: 1.45; color: var(--text-2);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .desc.none { font-style: italic; color: var(--text-3); }
    .sec-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .sec-chip { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px 0 7px; border-radius: 999px; font: 550 11.5px/1 var(--sans);
      white-space: nowrap; color: var(--text-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border-soft); }
    .sec-chip wl-nav-icon { color: var(--tone); }
    .sec-chip.home { color: var(--text-1); background: color-mix(in srgb, var(--tone) 16%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 42%, transparent); }
    .everything { display: flex; align-items: center; gap: 8px; padding: 8px 11px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-2);
      background: linear-gradient(90deg, color-mix(in srgb, var(--tone) 15%, transparent), transparent 85%);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 22%, transparent); }
    .everything wl-nav-icon { flex: none; color: var(--tone); }
    /* Services visibles : une ligne sobre, en couleur quand le profil les limite. */
    .svc-line { display: flex; align-items: center; gap: 7px; min-width: 0; margin: 0; font-size: 12px; color: var(--text-3); }
    .svc-line wl-nav-icon { flex: none; color: var(--ok); }
    .svc-line.limited { color: var(--text-1); font-family: var(--mono); font-size: 11.5px; }
    .svc-line.limited wl-nav-icon { color: var(--accent-3); }
    /* Pied de carte : hauteur fixe, actions toujours en place (rien ne bouge au survol). */
    .foot { display: flex; align-items: center; gap: 6px; min-height: 36px; padding-top: 10px; border-top: 1px solid var(--border-soft); }
    .users { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); transition: color .2s; }
    .users b { color: var(--text-1); font-variant-numeric: tabular-nums; }
    .users:hover { color: var(--accent); text-decoration: none; }
    .del:hover { color: var(--danger); }
    .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; min-width: 0; }
    .confirm > span { flex: 1 1 120px; min-width: 0; }
    .warn-text { display: inline-flex; align-items: center; gap: 6px; color: var(--warn); }
    .confirm-in { animation: confirm-in .35s var(--spring); }
    @keyframes confirm-in { from { opacity: 0; transform: translateX(10px); } }
    .ghost { pointer-events: none; }
    .p-tile-ghost { width: 42px; height: 42px; border-radius: 13px; }
    .ghost .title { gap: 8px; }
    .sec-chip-ghost { width: 84px; height: 24px; border-radius: 999px; }
    .empty p { margin: 0 auto 8px; }

    /* Éditeur. */
    .crumb { display: inline-flex; align-items: center; gap: 6px; }
    h1.ellipsis { min-width: 0; max-width: 100%; }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { flex: 1; min-width: min(220px, 100%); }
    .options input { width: 100%; }
    div.field { display: grid; gap: 6px; font-size: 12px; color: var(--text-2); }
    .icon-picks { display: flex; flex-wrap: wrap; gap: 6px; }
    .icon-pick { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid var(--border); border-radius: 11px;
      color: var(--text-2); background: var(--surface-2); cursor: pointer;
      transition: transform .3s var(--spring), border-color .2s, color .2s, background-color .2s, box-shadow .25s; }
    .icon-pick:hover { transform: translateY(-2px); color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
    .icon-pick:active { transform: scale(.92); }
    .icon-pick.on { color: var(--on-accent); border-color: transparent; box-shadow: 0 8px 18px -8px var(--tone);
      background: linear-gradient(135deg, var(--tone), color-mix(in srgb, var(--tone) 55%, var(--accent-2))); }
    .note { display: flex; align-items: flex-start; gap: 9px; margin: 0; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 12.5px;
      line-height: 1.45; color: var(--text-2); background: var(--accent-soft); }
    .note wl-nav-icon { flex: none; margin-top: 1px; color: var(--accent); }
    .category { display: grid; gap: 8px; }
    .category + .category { margin-top: 8px; }
    .cat-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 26px; }
    .cat-all { min-width: 104px; justify-content: center; }
    /* Parties : cartes à interrupteur ; survol : légère élévation, sans changer la mise en page. */
    .toggles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr)); gap: 8px; }
    .toggle { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 12px;
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); cursor: pointer;
      transition: transform .3s var(--spring), border-color .2s, background-color .25s; }
    .toggle:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
    .toggle:active { transform: scale(.98); }
    .toggle.on { border-color: color-mix(in srgb, var(--accent) 70%, transparent);
      background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent-2) 6%, transparent)); }
    .toggle.locked { cursor: default; }
    .toggle.locked:hover, .toggle.locked:active { transform: none; }
    .t-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; color: var(--accent); background: var(--accent-soft);
      transition: transform .45s var(--spring), color .25s, box-shadow .25s; }
    .toggle:hover .t-icon { transform: rotate(-8deg) scale(1.08); }
    .toggle.locked:hover .t-icon { transform: none; }
    .toggle.on .t-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 14px -6px var(--accent); }
    .t-text { display: grid; gap: 1px; min-width: 0; }
    .t-text strong { font-size: 13px; font-weight: 600; color: var(--text-1); }
    .t-text span { font-size: 11.5px; line-height: 1.35; color: var(--text-3); }
    .home-select { width: min(360px, 100%); height: 38px; }

    /* Aperçu : la barre de navigation telle que la verra une personne de ce profil. */
    .mini { display: grid; gap: 1px; padding: 12px 10px; border-radius: 16px; background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--border-soft), inset 0 1px 0 var(--highlight); }
    .mini-brand { display: flex; align-items: center; gap: 8px; padding: 0 6px 8px; font: 700 12.5px var(--mono); letter-spacing: -.02em; color: var(--text-1); }
    .mini-logo { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 8px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: inset 0 1px 0 rgb(255 255 255 / .4); }
    .mini-logo ::ng-deep path { fill: #fff; }
    .mini-group { display: grid; gap: 1px; }
    .mini-section { padding: 8px 8px 3px; font-size: 9.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); }
    .mini-link { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 8px; border-radius: 9px; font-size: 12px; color: var(--text-2); }
    .mini-link wl-nav-icon { flex: none; color: var(--text-3); }
    .mini-link.on { color: var(--text-1);
      background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 26%, transparent), color-mix(in srgb, var(--accent-2) 8%, transparent)); }
    .mini-link.on wl-nav-icon { color: var(--accent); }
    .mini-link.on::before { content: ''; position: absolute; left: -10px; top: 6px; bottom: 6px; width: 3px; border-radius: 0 3px 3px 0;
      background: var(--accent); box-shadow: 0 0 8px var(--accent); }
    .mini-home { flex: none; display: grid; place-items: center; width: 18px; height: 18px; margin-left: auto; border-radius: 6px; color: var(--accent); background: var(--accent-soft); }
    .mini-home wl-nav-icon { color: inherit; }
    .mini-empty { padding: 14px 8px; font-size: 12px; text-align: center; color: var(--text-3); }
    .mini-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 9px 8px 0; border-top: 1px solid var(--border-soft); font-size: 12px; color: var(--text-3); }
    .mini-in { animation: mini-in .35s var(--spring); }
    .mini-out { animation: mini-out .2s ease-in forwards; }
    @keyframes mini-in { from { opacity: 0; transform: translateX(-8px); } }
    @keyframes mini-out { to { opacity: 0; transform: translateX(-8px); } }
    .summary p { margin: 0; line-height: 1.5; }
    .admins { display: flex; align-items: center; gap: 6px; }
    .admins wl-nav-icon { color: var(--warn); }
    .error { display: inline-flex; align-items: center; gap: 7px; color: var(--danger); }
    .hint-in { animation: hint-in .35s var(--spring); }
    @keyframes hint-in { from { opacity: 0; transform: translateY(-4px); } }

    @media (max-width: 600px) {
      .page { padding: 14px 12px 24px; gap: 14px; }
      .form-page .step > .step-body { padding: 12px 14px 16px; }
      .form-page .step > .step-head { padding: 14px 14px 0; flex-wrap: wrap; }
    }
  `,
})
export class AdminAccessPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);
  /** Profil en cours de modification (?edit=<id>, « new » pour un nouveau) ; absent : la liste des profils. */
  readonly edit = input<string>();

  protected readonly profiles = signal<AccessProfile[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  /** Carte dont la suppression attend confirmation. */
  protected readonly confirm = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  // Profil en cours de saisie.
  protected readonly draftId = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly icon = signal(PROFILE_ICONS[0]);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly home = signal<string | null>(null);
  /** Services visibles (noms ou motifs) ; vide : tous. */
  protected readonly services = signal<string[]>([]);

  protected readonly editing = computed(() => !!this.edit());
  protected readonly current = computed(() => this.profiles().find((p) => p.id === this.draftId()) ?? null);
  protected readonly isAll = computed(() => this.draftId() === EVERYTHING);
  /** Parties cochées, dans l'ordre de la navigation. */
  protected readonly visible = computed(() => SECTIONS.filter((s) => this.chosen().has(s.id)));
  /** Page d'accueil : celle choisie si elle est cochée, sinon la première partie cochée. */
  protected readonly homeId = computed(() => {
    const h = this.home();
    const visible = this.visible();
    return h && visible.some((s) => s.id === h) ? h : (visible[0]?.id ?? null);
  });
  /** Aperçu de la navigation : familles non vides. */
  protected readonly preview = computed(() =>
    SECTION_CATEGORIES.map((c) => ({ id: c.id, items: this.visible().filter((s) => s.category === c.id) })).filter((g) => g.items.length),
  );
  protected readonly canSave = computed(() => !!this.name().trim() && this.chosen().size > 0 && !this.busy());

  protected readonly categories = SECTION_CATEGORIES;
  protected readonly icons = PROFILE_ICONS;
  protected readonly defaultIcon = PROFILE_ICONS[0];
  protected readonly everything = EVERYTHING;
  protected readonly total = SECTIONS.length;
  protected readonly tone = profileTone;
  protected readonly ghosts = [0, 1, 2];

  constructor() {
    this.load();
    // Ouverture de l'éditeur (lien « Modifier », « Nouveau profil », adresse partagée) une fois la liste connue.
    effect(() => {
      const id = this.edit() ?? null;
      if (!this.loaded()) return;
      untracked(() => this.open(id));
    });
  }

  protected load() {
    this.failed.set(false);
    this.api.accessProfiles().subscribe({
      next: (list) => {
        this.profiles.set(list);
        this.loaded.set(true);
      },
      error: () => {
        this.failed.set(true);
        this.loaded.set(true);
      },
    });
  }

  private open(id: string | null) {
    this.error.set('');
    this.confirm.set(null);
    if (!id) return;
    const p = id === 'new' ? null : this.profiles().find((x) => x.id === id);
    if (id !== 'new' && !p) {
      if (!this.failed()) this.toasts.error('Ce profil d’accès n’existe plus.');
      this.close();
      return;
    }
    this.draftId.set(p?.id ?? null);
    this.name.set(p?.name ?? '');
    this.description.set(p?.description ?? '');
    this.icon.set(p?.icon || PROFILE_ICONS[0]);
    this.chosen.set(new Set(p?.sections ?? []));
    this.home.set(p?.home ?? null);
    this.services.set([...(p?.services ?? [])]);
  }

  protected close() {
    this.router.navigate([], { queryParams: { edit: null }, queryParamsHandling: 'merge' });
  }

  protected sectionsIn(category: SectionCategory) {
    return SECTIONS.filter((s) => s.category === category);
  }

  protected fullCategory(category: SectionCategory) {
    return this.sectionsIn(category).every((s) => this.chosen().has(s.id));
  }

  protected toggle(id: string) {
    if (this.isAll()) return;
    this.chosen.update((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Coche toute la famille, ou la décoche si elle l'est déjà entièrement. */
  protected toggleCategory(category: SectionCategory) {
    if (this.isAll()) return;
    const ids = this.sectionsIn(category).map((s) => s.id);
    const full = this.fullCategory(category);
    this.chosen.update((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (full) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  protected sectionsOf(p: AccessProfile) {
    return SECTIONS.filter((s) => p.sections.includes(s.id));
  }

  protected scope(p: AccessProfile) {
    if (p.id === EVERYTHING) return 'Toutes les parties';
    const n = p.sections.length;
    return `${n} partie${n > 1 ? 's' : ''} sur ${this.total}`;
  }

  protected homeLabel(p: AccessProfile) {
    return sectionInfo(p.home ?? p.sections[0])?.label ?? '–';
  }

  protected servicesText(patterns: readonly string[] | null | undefined, max = 3) {
    return servicesLabel(patterns, max);
  }

  protected save() {
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set('');
    const profile: AccessProfile = {
      id: this.draftId() ?? '',
      name: this.name().trim(),
      description: this.description().trim() || null,
      icon: this.icon(),
      sections: this.visible().map((s) => s.id),
      home: this.homeId(),
      services: this.isAll() ? [] : this.services(),
      builtin: false,
    };
    this.api.saveAccessProfile(profile).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.toasts.ok(`Profil « ${saved.name} » enregistré`, saved.icon || PROFILE_ICONS[0]);
        this.profiles.update((list) => (list.some((p) => p.id === saved.id) ? list.map((p) => (p.id === saved.id ? saved : p)) : [...list, saved]));
        this.close();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
        this.toasts.error(this.error());
      },
    });
  }

  protected remove(p: AccessProfile) {
    this.confirm.set(null);
    this.api.deleteAccessProfile(p.id).subscribe({
      next: () => {
        this.toasts.ok(`Profil « ${p.name} » supprimé`, 'trash');
        this.profiles.update((list) => list.filter((x) => x.id !== p.id));
      },
      error: (e) => this.toasts.error(e?.error?.error ?? 'Suppression impossible.'),
    });
  }
}
