import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { Api } from './core/api';
import { EnvironmentInfo, ServiceInfo } from './core/models';
import { AppState } from './core/app-state';
import { Session } from './core/session';
import { RangePicker } from './shared/range-picker';
import { Logo } from './shared/logo';
import { CommandPalette } from './shared/command-palette';
import { NavIcon } from './shared/nav-icon';
import { RichOption, envColor, envLabel, envTone } from './shared/rich-option';
import { environmentsVersion } from './core/environments';
import { Toaster } from './shared/toaster';
import { UserMenu } from './shared/user-menu';
import { Preferences } from './core/preferences';
import { sectionForUrl, servicesLabel } from './core/access';
import { Branding } from './core/branding';
import { GO_SHORTCUTS, ShortcutsHelp } from './shared/shortcuts-help';
import { installTooltips } from './core/tooltips';
import { formatNumber, timeAgo } from './core/format';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, RangePicker, CommandPalette, Logo, NavIcon, RichOption, Toaster, ShortcutsHelp, UserMenu],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (isLogin()) {
      <router-outlet />
    } @else {
      <!-- Lueur qui suit le curseur, derrière le verre (déplacée sans passer par Angular, voir le constructeur). -->
      <div class="cursor-glow" #glow aria-hidden="true"></div>
      <!-- Menu : complet, réduit aux icônes (écran moyen ou au choix), ou tiroir ouvert par ☰ (téléphone). -->
      <div class="shell" [class.rail]="railed()" [class.phone]="phone()" [class.drawer-open]="drawer()">
        <aside class="nav glass" id="nav" [attr.aria-hidden]="phone() && !drawer() ? 'true' : null" [attr.inert]="phone() && !drawer() ? '' : null">
          <div class="brand-row">
            <a class="brand" [class.company]="!!branding.name()" [routerLink]="session.home()" [title]="branding.title() + '  accueil'">
              <span class="logo" [class.image]="!!branding.logoUrl()">@if (branding.logoUrl(); as src) { <img [src]="src" alt="" /> } @else { <wl-logo [size]="18" /> }</span>
              <span class="brand-name">{{ branding.name() ?? 'wolflog' }}</span>
            </a>
            <button class="nav-close" (click)="drawer.set(false)" title="Fermer le menu" aria-label="Fermer le menu"><wl-nav-icon name="close" /></button>
          </div>
          <!-- Seulement les parties ouvertes par le profil d'accès de l'utilisateur. -->
          @for (g of visibleGroups(); track g.label) {
            <nav [attr.aria-label]="g.label || 'Navigation principale'">
              @if (g.label) { <div class="section">{{ g.label }}</div> }
              @for (l of g.links; track l.path) {
                <a [routerLink]="l.path" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: l.path === '/' }" [attr.title]="railed() ? l.label : null">
                  <wl-nav-icon [name]="l.icon" /><span class="label">{{ l.label }}</span>
                  @if (l.path === '/alerts' && firing()) { <span class="badge">{{ firing() }}</span> }
                </a>
              }
            </nav>
          }
          @if (session.isAdmin()) {
            <nav aria-label="Administration">
              <div class="section">Administration</div>
              @for (l of adminLinks; track l.path) {
                <a [routerLink]="l.path" routerLinkActive="on" [attr.title]="railed() ? l.label : null"><wl-nav-icon [name]="l.icon" /><span class="label">{{ l.label }}</span></a>
              }
            </nav>
          }
          <!-- Compte, thème, animations, déconnexion : menu de l'avatar (barre du haut). Ici, seulement la largeur du menu. -->
          <div class="foot">
            <button class="rail-btn" (click)="toggleRail()" [title]="railed() ? 'Déplier le menu' : 'Réduire le menu'" [attr.aria-pressed]="railed()">
              <wl-nav-icon name="sidebar" /><span class="label">Réduire le menu</span></button>
          </div>
        </aside>
        @if (phone() && drawer()) {
          <div class="scrim" animate.enter="scrim-in" animate.leave="scrim-out" (click)="drawer.set(false)" aria-hidden="true"></div>
        }
        <main #main>
          <header class="top glass">
            <button class="btn icon menu-btn" (click)="openDrawer()" title="Menu" aria-label="Ouvrir le menu" aria-controls="nav" [attr.aria-expanded]="drawer()"><wl-nav-icon name="menu" /></button>
            <button class="btn search-btn" (click)="palette.set(true)" title="Recherche globale (Ctrl K)" aria-label="Recherche globale">
              <span class="search-label"><wl-nav-icon name="search" /><span class="search-text">Rechercher</span>
                <span class="hints" aria-hidden="true"><span>un log…</span><span>une trace…</span><span>une erreur…</span><span>un service…</span></span></span><kbd>Ctrl K</kbd>
            </button>
            <div class="filters">
            <!-- [selected] sur chaque option : la valeur reste visible même si la liste arrive après (filtre jamais caché). -->
            <select (change)="state.setService($any($event.target).value)" title="Service" [class.active]="state.service()">
              <option value="" [selected]="!state.service()" [wlOpt]="session.services() ? 'Tous mes services' : 'Tous les services'" icon="layers"
                      [desc]="services().length + ' service' + (services().length > 1 ? 's' : '') + ' actif' + (services().length > 1 ? 's' : '') + ' sur 7 jours'
                              + (session.services() ? ' · votre accès : ' + servicesLabel(session.services()!) : '')"></option>
              @for (s of serviceOptions(); track s) {
                <option [value]="s" [selected]="s === state.service()" [wlOpt]="s" avatar [desc]="serviceDesc(s)"
                        [meta]="serviceMeta(s)" [metaTone]="(serviceInfo().get(s)?.errors ?? 0) > 0 ? 'danger' : null"></option>
              }
            </select>
            @if (envOptions().length && envOptions().length <= 4 && !phone()) {
              <div class="seg env-seg" role="group" aria-label="Environnement" [style.--pill]="toneColor(state.env())">
                <button [class.on]="!state.env()" (click)="state.setEnv('')" title="Tous les environnements"><wl-nav-icon name="globe" [size]="13" />Tous</button>
                @for (e of envOptions(); track e) {
                  <button [class.on]="e === state.env()" (click)="state.setEnv(e)" [title]="envTitle(e)" [attr.aria-pressed]="e === state.env()">{{ envLabel(e) }}</button>
                }
              </div>
            } @else if (envOptions().length) {
              <select (change)="state.setEnv($any($event.target).value)" title="Environnement" [class.active]="state.env()">
                <option value="" [selected]="!state.env()" wlOpt="Tous les environnements" icon="globe" desc="Aucun filtre"></option>
                @for (e of envOptions(); track e) {
                  <option [value]="e" [selected]="e === state.env()" [wlOpt]="envLabel(e)" icon="server" [tone]="envColor(e)" [desc]="envSummary(e)"
                          [meta]="(envInfo().get(e)?.errors ?? 0) > 0 ? envErrors(e) : null" metaTone="danger"></option>
                }
              </select>
            }
            </div>
            <span class="spacer"></span>
            @if (firing()) {
              <a class="firing" routerLink="/alerts" [queryParams]="{ tab: 'active' }" [title]="firingTitle()"
                 [attr.aria-label]="firing() + ' alerte' + (firing() > 1 ? 's' : '') + ' en cours'"><wl-nav-icon name="alerts" [size]="13" /><span class="firing-count num">{{ firing() }}</span><span class="firing-text">alerte{{ firing() > 1 ? 's' : '' }} en cours</span></a>
            }
            <!-- Téléphone : service, environnement et actualisation automatique passent sur une deuxième ligne. -->
            <span class="row-break" aria-hidden="true"></span>
            <label class="check small auto" title="Actualisation automatique des données">
              <input type="checkbox" class="switch" [checked]="state.autoRefresh()" (change)="state.toggleAutoRefresh()" /><span class="auto-label">Actualisation auto</span>
            </label>
            <button class="btn icon" [class.live]="state.autoRefresh()" (click)="state.refresh()" [title]="state.autoRefresh() ? 'Actualisation automatique active  actualiser maintenant' : 'Actualiser'" aria-label="Actualiser"><wl-nav-icon name="refresh" /></button>
            <wl-range-picker />
            <wl-user-menu (help)="help.set(true)" />
          </header>
          <router-outlet />
          @if (scrolled()) {
            <button class="to-top" animate.enter="to-top-in" animate.leave="to-top-out" (click)="toTop()" title="Revenir en haut" aria-label="Revenir en haut">
              <wl-nav-icon name="arrow-up" />
            </button>
          }
        </main>
      </div>
      <wl-toaster />
      @if (help()) {
        <wl-shortcuts-help animate.leave="palette-out" (close)="help.set(false)" />
      }
      @if (palette()) {
        <wl-command-palette animate.leave="palette-out" (close)="palette.set(false)" />
      }
    }
  `,
  styles: `
    /* Seules transform et opacity sont animées (fluide) ; remplissage « backwards » : rien ne reste après l'entrée. */
    .cursor-glow { position: fixed; left: 0; top: 0; z-index: -1; width: 560px; height: 560px; border-radius: 50%; pointer-events: none;
      background: radial-gradient(closest-side, var(--glow), transparent); opacity: 0; transition: opacity .6s; will-change: transform; }
    .cursor-glow.on { opacity: 1; }
    .palette-out { animation: palette-out .18s ease-in forwards; }
    .to-top { position: fixed; right: 22px; bottom: 22px; z-index: 40; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
      border: 1px solid var(--border); background: var(--surface-solid); color: var(--accent); cursor: pointer;
      box-shadow: var(--shadow-pop), inset 0 1px 0 var(--highlight); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass);
      transition: transform .35s var(--spring), color .2s; }
    .to-top:hover { transform: translateY(-3px); }
    .to-top:active { transform: scale(.9); }
    .to-top-in { animation: to-top-in .45s var(--spring); }
    .to-top-out { animation: to-top-out .2s ease-in forwards; }
    @keyframes to-top-in { from { opacity: 0; transform: translateY(16px) scale(.6); } }
    @keyframes to-top-out { to { opacity: 0; transform: translateY(12px) scale(.7); } }
    @keyframes palette-out { to { opacity: 0; } }
    .shell { display: grid; grid-template-columns: 216px 1fr; height: 100vh; overflow: hidden; padding: 10px 0 10px 10px; }
    .nav { height: calc(100vh - 20px); overflow: auto; display: flex; flex-direction: column; gap: 2px; padding: 16px 10px; border-radius: 22px;
      animation: nav-in .55s var(--ease) backwards; }
    @keyframes nav-in { from { opacity: 0; transform: translateX(-16px); } }
    nav > a, .foot > * { animation: link-in .45s var(--ease) backwards; }
    nav > a:nth-child(1) { animation-delay: .06s; } nav > a:nth-child(2) { animation-delay: .09s; } nav > a:nth-child(3) { animation-delay: .12s; }
    nav > a:nth-child(4) { animation-delay: .15s; } nav > a:nth-child(5) { animation-delay: .18s; } nav > a:nth-child(6) { animation-delay: .21s; }
    nav > a:nth-child(7) { animation-delay: .24s; } nav > a:nth-child(8) { animation-delay: .27s; } nav > a:nth-child(9) { animation-delay: .3s; }
    @keyframes link-in { from { opacity: 0; transform: translateX(-8px); } }
    .brand { display: flex; align-items: center; gap: 10px; font: 700 15px var(--mono); color: var(--text-1); padding: 2px 8px 14px; letter-spacing: -.02em; }
    .brand:hover { text-decoration: none; }
    .logo { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 11px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 20px -8px var(--accent), inset 0 1px 0 rgb(255 255 255 / .4);
      transition: transform .5s var(--spring); }
    .brand:hover .logo { transform: rotate(-12deg) scale(1.08); }
    /* Logo et nom de l'entreprise (Administration › Personnalisation) : image à hauteur fixe, nom en texte courant. */
    .brand { min-width: 0; }
    .brand-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .brand.company .brand-name { font: 650 14.5px var(--sans); letter-spacing: 0; }
    .logo.image { width: auto; height: auto; background: none; box-shadow: none; }
    .brand:hover .logo.image { transform: none; }
    .logo img { display: block; height: 28px; width: auto; max-width: 120px; object-fit: contain; }
    .shell.rail .logo img { max-width: 40px; }
    .logo ::ng-deep path { fill: #fff; }
    nav, .foot { display: grid; gap: 1px; }
    nav a, .foot a, .foot > button { position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 11px;
      color: var(--text-2); font: 500 13px var(--sans); border: 0; background: none; text-align: left; cursor: pointer;
      transition: background-color .2s, color .2s, transform .3s var(--spring); }
    nav a:hover, .foot a:hover, .foot > button:hover { color: var(--text-1); background-color: var(--surface-3); text-decoration: none; transform: translateX(3px); }
    @supports (anchor-name: --a) {
      .nav { position: relative; anchor-scope: --nav-hover; }
      nav a { z-index: 1; }
      nav a:hover { anchor-name: --nav-hover; background-color: transparent; }
      .nav::after { content: ''; position: absolute; z-index: 0; pointer-events: none; border-radius: 11px; background: var(--surface-3);
        position-anchor: --nav-hover; top: anchor(top); left: anchor(left); width: anchor-size(width); height: anchor-size(height);
        opacity: 0; transition: top .3s var(--spring), height .3s var(--ease), opacity .2s; }
      .nav:has(nav a:hover)::after { opacity: 1; }
    }
    nav a:active, .foot > button:active { transform: scale(.97); }
    nav a wl-nav-icon, .foot wl-nav-icon { color: var(--text-3); transition: color .2s, transform .4s var(--spring); }
    nav a:hover wl-nav-icon, .foot a:hover wl-nav-icon, .foot > button:hover wl-nav-icon { color: var(--text-2); transform: scale(1.15) rotate(-8deg); }
    nav a.on, .foot a.on { color: var(--text-1);
      background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 26%, transparent), color-mix(in srgb, var(--accent-2) 8%, transparent));
      box-shadow: inset 0 1px 0 var(--highlight); }
    nav a.on wl-nav-icon, .foot a.on wl-nav-icon { color: var(--accent); }
    nav a.on::before { content: ''; position: absolute; left: -10px; top: 7px; bottom: 7px; width: 3px; border-radius: 0 3px 3px 0;
      background: linear-gradient(var(--accent), var(--accent-3)); box-shadow: 0 0 10px var(--accent); animation: indicator .45s var(--spring) backwards; }
    @keyframes indicator { from { transform: scaleY(0); opacity: 0; } }
    .section { padding: 14px 10px 4px; font-size: 10.5px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: .08em; }
    .foot { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--border-soft); }
    .foot > button, .foot a { font-size: 12.5px; color: var(--text-3); }
    .badge { position: relative; animation: badge-in .5s var(--spring) backwards; display: inline-block; min-width: 18px; padding: 0 5px; margin-left: auto; border-radius: 9px; background: var(--danger); color: #fff;
      font: 600 11px/17px var(--sans); text-align: center; }
    @keyframes badge-in { from { transform: scale(0); } }
    .firing { display: inline-flex; align-items: center; gap: 8px; color: var(--danger); font-weight: 600; font-size: 12.5px; padding: 5px 10px;
      border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--danger) 10%, transparent); }
    .firing:hover { text-decoration: none; background: color-mix(in srgb, var(--danger) 18%, transparent); }
    /* Seule zone qui défile ; la page routée remplit la hauteur restante. */
    main { min-width: 0; height: calc(100vh - 20px); overflow: auto; display: flex; flex-direction: column; }
    main > :not(header):not(router-outlet) { flex: 1 0 auto; display: block; }
    .search-btn { min-width: 240px; justify-content: space-between; color: var(--text-3); border-radius: 999px; padding: 0 6px 0 12px; }
    .search-btn:hover kbd { border-color: var(--accent); color: var(--accent); }
    .search-label { display: inline-flex; align-items: center; gap: 6px; }
    .search-label wl-nav-icon { margin-right: 2px; transition: transform .4s var(--spring); }
    .search-btn:hover .search-label wl-nav-icon { transform: scale(1.15) rotate(-12deg); }
    /* Suggestions qui se relaient (opacité et translation uniquement). */
    .hints { position: relative; display: inline-block; width: 92px; height: 1.4em; overflow: hidden; vertical-align: middle; }
    .hints span { position: absolute; left: 0; top: 0; white-space: nowrap; opacity: 0; animation: hint 12s var(--ease) infinite; }
    .hints span:nth-child(2) { animation-delay: 3s; }
    .hints span:nth-child(3) { animation-delay: 6s; }
    .hints span:nth-child(4) { animation-delay: 9s; }
    @keyframes hint { 0% { opacity: 0; transform: translateY(70%); } 4%, 21% { opacity: 1; transform: none; } 25%, 100% { opacity: 0; transform: translateY(-70%); } }
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .btn.icon wl-nav-icon { transition: transform .6s var(--ease); }
    .btn.icon:hover wl-nav-icon { transform: rotate(180deg); }
    .btn.icon.live { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
    /* Barre du haut : le contenu défile dessous, d'où le verre dépoli (flou) réservé à elle. */
    .top { position: sticky; top: 0; z-index: 20; flex: none; display: flex; align-items: center; gap: 10px; margin: 0 12px; padding: 8px 10px;
      border-radius: 18px; backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); animation: top-in .55s var(--ease) .08s backwards; }
    @keyframes top-in { from { opacity: 0; transform: translateY(-12px); } }
    @supports (animation-timeline: scroll()) {
      .top { animation: top-in .55s var(--ease) .08s backwards, top-lift linear both; animation-timeline: auto, scroll(nearest); animation-range: normal, 0 90px; }
      @keyframes top-lift { to { box-shadow: 0 18px 40px -18px rgb(0 0 0 / .7), 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent), inset 0 1px 0 var(--highlight); } }
    }
    .top select { min-width: 170px; border-radius: 999px; }
    /* Environnements : la pastille glissante prend la couleur de l'environnement choisi (production en rouge…). */
    .env-seg { border-radius: 999px; }
    .env-seg button { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; }
    .env-seg::before { border-radius: 999px;
      background: color-mix(in srgb, var(--pill, var(--accent)) 30%, transparent);
      box-shadow: 0 4px 14px -6px var(--pill, var(--accent)), inset 0 0 0 1px color-mix(in srgb, var(--pill, var(--accent)) 50%, transparent), inset 0 1px 0 rgb(255 255 255 / .2);
      transition: left .45s var(--spring), width .45s var(--spring), top .3s var(--ease), height .3s var(--ease), background-color .35s, box-shadow .35s; }
    /* Filtre actif : bien visible. */
    .top select.active { border-color: var(--accent); color: var(--text-1); background: var(--accent-soft); }
    .filters { display: contents; }
    .row-break, .menu-btn, .nav-close { display: none; }
    .auto { white-space: nowrap; }
    .firing-count { display: none; }

    /* Barre du haut qui se resserre selon sa largeur (requêtes de conteneur) : rien n'est coupé ni ne déborde. */
    .top { container: top / inline-size; }
    @container top (max-width: 1180px) {
      .hints { display: none; }
      .search-btn { min-width: 0; }
    }
    @container top (max-width: 1040px) {
      .auto-label, .firing-text { display: none; }
      .firing-count { display: inline; }
      .firing { padding: 5px 9px; }
      .top select { min-width: 0; max-width: 210px; }
    }
    @container top (max-width: 900px) {
      .search-text, .search-btn kbd { display: none; }
      .search-btn { width: 32px; padding: 0; justify-content: center; }
      .top select { max-width: 170px; }
    }

    /* Menu réduit aux icônes : écran moyen, ou au choix (bouton « Réduire le menu », mémorisé). */
    .brand-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .rail-btn wl-nav-icon { transition: transform .4s var(--spring); }
    .shell.rail { grid-template-columns: 68px 1fr; }
    .shell.rail .nav { padding: 14px 8px; }
    .shell.rail .brand-row { justify-content: center; }
    .shell.rail .brand { padding: 2px 0 14px; }
    .shell.rail .brand-name, .shell.rail .label, .shell.rail .section { display: none; }
    .shell.rail nav a, .shell.rail .foot a, .shell.rail .foot > button { justify-content: center; padding: 9px 0; }
    .shell.rail nav a:hover, .shell.rail .foot a:hover, .shell.rail .foot > button:hover { transform: none; }
    .shell.rail nav + nav { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border-soft); }
    .shell.rail nav a.on::before { left: -8px; }
    .shell.rail .badge { position: absolute; top: 2px; right: 6px; min-width: 16px; margin: 0; padding: 0 4px; font-size: 10px; line-height: 15px; }
    .shell.rail .rail-btn wl-nav-icon { transform: scaleX(-1); }

    /* Téléphone : menu en tiroir (☰), barre du haut sur deux lignes. */
    .shell.phone { grid-template-columns: minmax(0, 1fr); padding: 0; }
    .shell.phone main { height: 100dvh; }
    .shell.phone .nav { position: fixed; z-index: 60; left: 8px; top: 8px; bottom: 8px; width: min(290px, calc(100vw - 48px)); height: auto;
      background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); animation: none;
      transform: translateX(calc(-100% - 12px)); visibility: hidden; transition: transform .3s var(--ease), visibility 0s linear .3s; }
    .shell.phone.drawer-open .nav { transform: none; visibility: visible; box-shadow: var(--shadow-pop); transition: transform .4s var(--spring), visibility 0s; }
    .shell.phone .menu-btn { display: inline-flex; }
    .shell.phone .nav-close { display: inline-grid; place-items: center; width: 32px; height: 32px; margin-top: -14px; border: 0; border-radius: 10px;
      background: none; color: var(--text-3); cursor: pointer; }
    .shell.phone .nav-close:hover { color: var(--text-1); background: var(--surface-3); }
    .shell.phone .rail-btn { display: none; }
    .scrim { position: fixed; inset: 0; z-index: 55; background: rgb(0 0 0 / .4); }
    .scrim-in { animation: scrim-in .3s ease-out; }
    .scrim-out { animation: scrim-out .2s ease-in forwards; }
    @keyframes scrim-in { from { opacity: 0; } }
    @keyframes scrim-out { to { opacity: 0; } }
    .shell.phone .top { flex-wrap: wrap; gap: 8px; margin: 6px 6px 0; padding: 6px 8px; border-radius: 16px; }
    .shell.phone .row-break { display: block; order: 19; flex-basis: 100%; height: 0; }
    .shell.phone .filters { display: flex; order: 20; flex: 1 1 0; gap: 8px; min-width: 0; }
    .shell.phone .filters select { flex: 1 1 0; min-width: 0; max-width: none; }
    .shell.phone .auto { order: 21; }
    .shell.phone .to-top { right: 14px; bottom: 14px; }
  `,
})
export class App {
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly services = signal<ServiceInfo[]>([]);
  protected readonly environments = signal<string[]>([]);
  /** Activité par environnement (infobulles et descriptions du sélecteur). */
  protected readonly envInfo = signal(new Map<string, EnvironmentInfo>());
  protected readonly palette = signal(false);
  /** Navigation par groupes ; section : partie de Wolflog (profils d'accès). */
  protected readonly navGroups = [
    { label: '', links: [
      { path: '/', label: "Vue d'ensemble", icon: 'overview', section: 'overview' },
      { path: '/dashboards', label: 'Tableaux de bord', icon: 'dashboards', section: 'dashboards' },
      { path: '/logs', label: 'Logs', icon: 'logs', section: 'logs' },
      { path: '/requests', label: 'Requêtes HTTP', icon: 'requests', section: 'requests' },
      { path: '/traces', label: 'Traces', icon: 'traces', section: 'traces' },
      { path: '/errors', label: 'Erreurs', icon: 'errors', section: 'errors' },
      { path: '/metrics', label: 'Métriques', icon: 'metrics', section: 'metrics' },
      { path: '/map', label: 'Carte des services', icon: 'map', section: 'map' },
      { path: '/profiles', label: 'Profils', icon: 'profiles', section: 'profiles' },
    ] },
    { label: 'Web', links: [
      { path: '/audience', label: 'Audience', icon: 'audience', section: 'audience' },
      { path: '/clickmaps', label: 'Clics & défilement', icon: 'clickmaps', section: 'clickmaps' },
    ] },
    { label: 'Surveiller', links: [
      { path: '/alerts', label: 'Alertes', icon: 'alerts', section: 'alerts' },
      { path: '/uptime', label: 'Disponibilité', icon: 'uptime', section: 'uptime' },
      { path: '/slos', label: 'Objectifs (SLO)', icon: 'slos', section: 'slos' },
    ] },
  ];
  /** Groupes et liens visibles avec le profil d'accès (rien tant que la session n'est pas connue : pas de clignotement). */
  protected readonly visibleGroups = computed(() => {
    if (!this.session.me()) return [];
    return this.navGroups
      .map((g) => ({ label: g.label, links: g.links.filter((l) => this.session.can(l.section)) }))
      .filter((g) => g.links.length);
  });
  protected readonly adminLinks = [
    { path: '/admin/users', label: 'Utilisateurs', icon: 'users' },
    { path: '/admin/access', label: "Profils d'accès", icon: 'id-card' },
    { path: '/admin/sso', label: 'Connexion SSO', icon: 'sso' },
    { path: '/admin/branding', label: 'Personnalisation', icon: 'palette' },
    { path: '/admin/environments', label: 'Environnements', icon: 'globe' },
    { path: '/admin/keys', label: 'Clés API', icon: 'keys' },
    { path: '/admin/sources', label: 'Sources', icon: 'sources' },
    { path: '/system', label: 'Système', icon: 'system' },
  ];

  /** Thème, couleurs, animations, lueur du pointeur, menu réduit : réglés dans le menu de l'avatar. */
  private readonly prefs = inject(Preferences);
  /** Logo et nom de l'entreprise (sinon ceux de Wolflog). */
  protected readonly branding = inject(Branding);
  /** Téléphone : menu en tiroir. Écran moyen : menu en icônes (sauf si l'utilisateur l'a déplié). */
  protected readonly phone = this.media('(max-width: 760px)');
  private readonly medium = this.media('(max-width: 1100px)');
  protected readonly railed = computed(() => !this.phone() && (this.prefs.nav() === 'on' || (this.prefs.nav() === 'auto' && this.medium())));
  protected readonly drawer = signal(false);
  private readonly glow = viewChild<ElementRef<HTMLDivElement>>('glow');
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');
  /** Zone principale défilée loin : bouton « Revenir en haut ». */
  protected readonly scrolled = signal(false);
  protected readonly envTone = envTone;
  protected readonly envColor = envColor;
  protected readonly envLabel = envLabel;
  protected readonly servicesLabel = servicesLabel;
  /** Services connus par nom (listes enrichies de la barre du haut). */
  protected readonly serviceInfo = computed(() => new Map(this.services().map((s) => [s.name, s])));
  /** Le service ou l'environnement filtré figure toujours dans la liste, même sans donnée récente. */
  protected readonly serviceOptions = computed(() => {
    const names = this.services().map((s) => s.name);
    const current = this.state.service();
    return current && !names.includes(current) ? [current, ...names] : names;
  });
  protected readonly envOptions = computed(() => {
    const current = this.state.env();
    return current && !this.environments().includes(current) ? [current, ...this.environments()] : this.environments();
  });
  /** Alertes actives (badge de la navigation et de la barre du haut). */
  protected readonly firing = signal(0);
  protected readonly firingTitle = signal('');

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => (e as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: null },
  );
  /** Avant la première navigation, l'adresse de la barre du navigateur fait foi (lien direct). */
  protected readonly isLogin = computed(() => (this.url() ?? location.pathname).startsWith('/login'));

  constructor() {
    this.readUrl();
    // Un lien interne peut porter la période, le service ou l'environnement : ils s'appliquent à l'arrivée.
    // Sur téléphone, le tiroir du menu se referme une fois la page choisie.
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.readUrl();
      this.drawer.set(false);
    });
    effect(() => {
      if (!this.phone()) untracked(() => this.drawer.set(false));
    });
    this.loadServices();
    setInterval(() => {
      this.loadServices();
      this.loadEnvironments();
    }, 60_000);
    // Application choisie, ou réglages enregistrés (Administration › Environnements) : liste rechargée.
    effect(() => {
      this.state.service();
      environmentsVersion();
      untracked(() => this.loadEnvironments());
    });
    setInterval(() => this.loadAlerts(), 30_000);
    effect(() => {
      this.state.tick();
      this.session.me(); // dès que la session est connue
      untracked(() => this.loadAlerts());
    });

    // La période et les filtres sont dans l'URL : un lien copié ouvre exactement la même vue.
    effect(() => {
      const params = { from: this.state.from(), to: this.state.to() || null, service: this.state.service() || null, env: this.state.env() || null };
      const url = this.url();
      untracked(() => {
        // Attendre la fin de la première navigation : sinon elle serait remplacée par la racine.
        if (url === null || this.isLogin()) return;
        const current = new URLSearchParams(location.search);
        const same = Object.entries(params).every(([k, v]) => (current.get(k) ?? null) === (v ?? null));
        if (!same) this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge', replaceUrl: true });
      });
    });

    this.followPointer();
    this.ripples();
    this.titleWithAlerts();
    const removeTooltips = installTooltips();
    inject(DestroyRef).onDestroy(removeTooltips);
    // Défilement de la zone principale : écouteur passif, signal modifié seulement au passage du seuil.
    effect((cleanup) => {
      const el = this.main()?.nativeElement;
      if (!el) return;
      const onScroll = () => {
        const far = el.scrollTop > 700;
        if (far !== this.scrolled()) this.scrolled.set(far);
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      cleanup(() => el.removeEventListener('scroll', onScroll));
    });
  }

  /** Signal qui suit une requête média (largeur d'écran). */
  private media(query: string) {
    const list = matchMedia(query);
    const value = signal(list.matches);
    const update = () => value.set(list.matches);
    list.addEventListener('change', update);
    inject(DestroyRef).onDestroy(() => list.removeEventListener('change', update));
    return value.asReadonly();
  }

  /** Réduit ou déplie le menu ; le choix est mémorisé (et prime sur le réglage automatique selon la largeur). */
  protected toggleRail() {
    this.prefs.setNav(this.railed() ? 'off' : 'on');
  }

  protected openDrawer() {
    this.drawer.set(true);
    // Focus dans le tiroir (clavier et lecteurs d'écran), une fois visible.
    setTimeout(() => document.querySelector<HTMLElement>('.nav .nav-close')?.focus(), 50);
  }

  /** Titre de l'onglet préfixé par le nombre d'alertes en cours : « (2) Logs · Wolflog ». */
  private titleWithAlerts() {
    effect(() => {
      const n = this.firing();
      this.url();
      untracked(() => setTimeout(() => {
        const base = document.title.replace(/^\(\d+\) /, '');
        document.title = n ? `(${n}) ${base}` : base;
      }));
    });
  }

  protected toTop() {
    this.main()?.nativeElement.scrollTo({ top: 0, behavior: this.prefs.motion() ? 'smooth' : 'auto' });
  }

  protected serviceDesc(name: string) {
    const s = this.serviceInfo().get(name);
    return s ? `${formatNumber(s.logs)} logs · ${formatNumber(s.spans)} spans${s.p95Ms !== null ? ' · p95 ' + Math.round(s.p95Ms) + ' ms' : ''}` : 'aucune donnée récente';
  }

  protected serviceMeta(name: string) {
    const s = this.serviceInfo().get(name);
    if (!s) return null;
    return s.errors > 0 ? `${formatNumber(s.errors)} err.` : timeAgo(s.lastSeen);
  }

  /** Couleur CSS d'un environnement (pastille, pastille glissante) ; aucun : couleur d'accent. */
  protected toneColor(env: string | null | undefined) {
    return env ? envColor(env) : 'var(--accent)';
  }

  protected envSummary(env: string) {
    const e = this.envInfo().get(env);
    if (!e) return this.envKind(env);
    return `${this.envKind(env)} · ${formatNumber(e.logs)} logs · ${e.services} service${e.services > 1 ? 's' : ''}`;
  }

  protected envErrors(env: string) {
    return `${formatNumber(this.envInfo().get(env)?.errors ?? 0)} err.`;
  }

  /** Infobulle d'un environnement : type, volumes et dernière donnée (7 jours). */
  protected envTitle(env: string) {
    const e = this.envInfo().get(env);
    const kind = this.envKind(env);
    const label = envLabel(env);
    if (!e) return `${label}  ${kind}`;
    const grouped = e.raw?.some((r) => r !== env) ? `\nregroupe ${e.raw.join(', ')}` : '';
    return `${label}  ${kind}${grouped}\n${formatNumber(e.logs)} logs · ${formatNumber(e.errors)} erreurs · ${formatNumber(e.spans)} spans\n`
      + `${e.services} service${e.services > 1 ? 's' : ''} · dernière donnée ${timeAgo(e.lastSeen)}`;
  }

  protected envKind(env: string) {
    return { danger: 'production', warn: 'recette, préproduction', ok: 'développement', accent: 'environnement' }[envTone(env)] ?? '';
  }

  /** Onde au clic sur les boutons, onglets et cartes de choix (écouteur DOM direct, animation CSS composée). */
  private ripples() {
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const host = (e.target as Element | null)?.closest?.('.btn, .seg button, .choice');
      if (!(host instanceof HTMLElement) || host.matches(':disabled')) return;
      const r = host.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2.4;
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      Object.assign(ripple.style, {
        width: `${size}px`, height: `${size}px`, left: `${e.clientX - r.left - size / 2}px`, top: `${e.clientY - r.top - size / 2}px`,
      });
      host.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    };
    document.addEventListener('pointerdown', down, { passive: true });
    inject(DestroyRef).onDestroy(() => document.removeEventListener('pointerdown', down));
  }

  /**
   * Lueur derrière le verre qui suit le curseur. Écouteur DOM direct (pas de détection de changements d'Angular
   * à chaque mouvement), une mise à jour par image au plus, déplacement par transform (composé, sans repeinture).
   */
  private followPointer() {
    let frame = 0, x = 0, y = 0;
    // Lueur coupée dans les préférences : elle s'efface, et les mouvements ne sont plus suivis.
    effect(() => {
      if (!this.prefs.glow()) untracked(() => this.glow()?.nativeElement.classList.remove('on'));
    });
    const move = (e: PointerEvent) => {
      if (!this.prefs.glow()) return;
      x = e.clientX;
      y = e.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const el = this.glow()?.nativeElement;
        if (!el) return;
        el.style.transform = `translate3d(${x - 280}px, ${y - 280}px, 0)`;
        el.classList.add('on');
      });
    };
    const leave = () => this.glow()?.nativeElement.classList.remove('on');
    document.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('mouseleave', leave);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('mouseleave', leave);
      cancelAnimationFrame(frame);
    });
  }

  private readUrl() {
    const p = new URLSearchParams(location.search);
    const from = p.get('from');
    // Seulement ce qui change : chaque changement recharge les données.
    if (from) {
      const to = p.get('to') ?? '';
      if (to && (from !== this.state.from() || to !== this.state.to())) this.state.setAbsolute(new Date(from), new Date(to));
      else if (!to && (from !== this.state.from() || this.state.to())) this.state.setRelative(from);
    }
    const service = p.get('service');
    if (service !== null && service !== this.state.service()) this.state.setService(service);
    const env = p.get('env');
    if (env !== null && env !== this.state.env()) this.state.setEnv(env);
  }

  private loadServices() {
    if (this.isLogin()) return;
    this.api.services({ from: '7d', to: '' }).subscribe({ next: (s) => this.services.set(s), error: () => {} });
  }

  /** Environnements de l'application choisie (tous sans filtre), avec leurs libellés et couleurs réglés. */
  private loadEnvironments() {
    if (this.isLogin()) return;
    const service = this.state.service();
    this.api.environmentStats(service).subscribe({
      next: (list) => {
        this.envInfo.set(new Map(list.map((e) => [e.name, e])));
        this.environments.set(list.map((e) => e.name));
        // Ancien lien (?env=Production) : la même entrée que la liste, sans doublon dans le sélecteur.
        const current = this.state.env();
        const same = current ? list.find((e) => e.name !== current && e.name.toLowerCase() === current.toLowerCase()) : undefined;
        if (same) this.state.setEnv(same.name);
      },
      error: () => this.api.environments(service).subscribe({ next: (e) => this.environments.set(e), error: () => {} }),
    });
  }

  private loadAlerts() {
    if (this.isLogin() || !this.session.me()?.authenticated) return;
    // Profil d'accès sans les alertes : ni pastille ni requête (elle serait refusée).
    if (!this.session.can('alerts')) {
      this.firing.set(0);
      this.firingTitle.set('');
      return;
    }
    this.api.activeAlerts().subscribe({
      next: (a) => {
        this.firing.set(a.firing);
        this.firingTitle.set(a.items.filter((x) => x.status === 'firing').slice(0, 5).map((x) => x.message ?? x.ruleName).join('\n'));
      },
      error: () => {},
    });
  }

  /** Aide des raccourcis (touche « ? »). */
  protected readonly help = signal(false);
  /** Première touche « g » d'un raccourci de navigation (« g » puis une lettre, dans la seconde). */
  private goPending = 0;

  protected onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.palette.update((v) => !v);
      return;
    }
    if (e.key === 'Escape') {
      // Une liste déroulante ouverte se ferme d'abord, seule.
      try { if ((e.target as Element | null)?.matches?.('select:open')) return; } catch { /* :open inconnu */ }
      this.help.set(false);
      if (this.drawer()) {
        this.drawer.set(false);
        document.querySelector<HTMLElement>('.menu-btn')?.focus();
      }
      return;
    }
    // Les autres raccourcis ne s'appliquent pas pendant une saisie.
    const t = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === '?') {
      this.help.update((v) => !v);
      return;
    }
    if (this.goPending && Date.now() - this.goPending < 1200) {
      this.goPending = 0;
      const target = GO_SHORTCUTS.find((s) => s.key === e.key.toLowerCase());
      if (target && this.session.can(sectionForUrl(target.path))) {
        e.preventDefault();
        this.router.navigateByUrl(target.path);
      }
      return;
    }
    if (e.key === 'g') this.goPending = Date.now();
  }
}
