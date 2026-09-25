import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { Api, ServiceInfo } from './core/api';
import { AppState, Session } from './core/state';
import { RangePicker } from './shared/widgets';
import { Logo } from './shared/logo';
import { CommandPalette } from './shared/command-palette';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, RangePicker, CommandPalette, Logo],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (isLogin()) {
      <router-outlet />
    } @else {
      <div class="shell">
        <aside class="nav">
          <a class="brand" routerLink="/"><wl-logo [size]="20" />wolflog</a>
          <nav>
            <a routerLink="/" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }">Vue d'ensemble</a>
            <a routerLink="/dashboards" routerLinkActive="on">Tableaux de bord</a>
            <a routerLink="/logs" routerLinkActive="on">Logs</a>
            <a routerLink="/requests" routerLinkActive="on">Requêtes HTTP</a>
            <a routerLink="/traces" routerLinkActive="on">Traces</a>
            <a routerLink="/errors" routerLinkActive="on">Erreurs</a>
            <a routerLink="/metrics" routerLinkActive="on">Métriques</a>
            <a routerLink="/map" routerLinkActive="on">Carte des services</a>
            <a routerLink="/profiles" routerLinkActive="on">Profils</a>
          </nav>
          <nav>
            <div class="section">Surveiller</div>
            <a routerLink="/alerts" routerLinkActive="on">Alertes @if (firing()) { <span class="badge">{{ firing() }}</span> }</a>
            <a routerLink="/uptime" routerLinkActive="on">Disponibilité</a>
            <a routerLink="/slos" routerLinkActive="on">Objectifs (SLO)</a>
          </nav>
          @if (session.isAdmin()) {
            <nav>
              <div class="section">Administration</div>
              <a routerLink="/admin/users" routerLinkActive="on">Utilisateurs</a>
              <a routerLink="/admin/keys" routerLinkActive="on">Clés API</a>
              <a routerLink="/admin/sources" routerLinkActive="on">Sources</a>
              <a routerLink="/system" routerLinkActive="on">Système</a>
            </nav>
          }
          <div class="foot">
            @if (session.me()?.authEnabled) {
              <a routerLink="/account" routerLinkActive="on" class="me" [title]="'Connecté : ' + session.me()?.user">{{ session.me()?.displayName || session.me()?.user }}</a>
            }
            <button (click)="toggleTheme()">Thème clair / sombre</button>
            @if (session.me()?.authEnabled) {
              <button (click)="logout()">Déconnexion</button>
            }
          </div>
        </aside>
        <main>
          <header class="top">
            <button class="btn search-btn" (click)="palette.set(true)" title="Recherche globale">
              <span>Rechercher…</span><kbd>Ctrl K</kbd>
            </button>
            <!-- [selected] sur chaque option : la valeur reste visible même si la liste arrive après (filtre jamais caché). -->
            <select (change)="state.setService($any($event.target).value)" title="Service" [class.active]="state.service()">
              <option value="" [selected]="!state.service()">Tous les services</option>
              @for (s of serviceOptions(); track s) {
                <option [value]="s" [selected]="s === state.service()">{{ s }}</option>
              }
            </select>
            @if (envOptions().length) {
              <select (change)="state.setEnv($any($event.target).value)" title="Environnement" [class.active]="state.env()">
                <option value="" [selected]="!state.env()">Tous les environnements</option>
                @for (e of envOptions(); track e) {
                  <option [value]="e" [selected]="e === state.env()">{{ e }}</option>
                }
              </select>
            }
            <span class="spacer"></span>
            @if (firing()) {
              <a class="firing" routerLink="/alerts" [queryParams]="{ tab: 'active' }" [title]="firingTitle()">{{ firing() }} alerte{{ firing() > 1 ? 's' : '' }} en cours</a>
            }
            <label class="check small">
              <input type="checkbox" [checked]="state.autoRefresh()" (change)="state.toggleAutoRefresh()" /> Actualisation auto
            </label>
            <button class="btn" (click)="state.refresh()">Actualiser</button>
            <wl-range-picker />
          </header>
          <router-outlet />
        </main>
      </div>
      @if (palette()) {
        <wl-command-palette (close)="palette.set(false)" />
      }
    }
  `,
  styles: `
    .shell { display: grid; grid-template-columns: 180px 1fr; height: 100vh; overflow: hidden; }
    .nav { height: 100vh; overflow: auto; display: flex; flex-direction: column; padding: 12px 0;
      background: var(--surface); border-right: 1px solid var(--border); }
    .brand { display: flex; align-items: center; gap: 8px; font: 700 15px var(--mono); color: var(--text-1); padding: 4px 16px 16px; letter-spacing: -.02em; }
    .brand:hover { text-decoration: none; }
    nav, .foot { display: grid; }
    nav a, .foot a, .foot button { display: block; padding: 6px 16px; color: var(--text-2); font: 13px var(--sans);
      border: 0; border-left: 2px solid transparent; background: none; text-align: left; cursor: pointer; }
    nav a:hover, .foot a:hover, .foot button:hover { color: var(--text-1); text-decoration: none; }
    nav a.on, .foot a.on { color: var(--text-1); border-left-color: var(--accent); background: var(--accent-soft); }
    .section { padding: 16px 16px 4px; font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: .05em; }
    .foot { margin-top: auto; padding-top: 12px; }
    .badge { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 4px; border-radius: 9px; background: var(--danger); color: var(--bg);
      font: 600 11px/16px var(--sans); text-align: center; }
    .firing { color: var(--danger); font-weight: 600; font-size: 12.5px; padding: 4px 8px; border: 1px solid var(--danger); border-radius: var(--radius); }
    .firing:hover { text-decoration: none; background: var(--row-hover); }
    .foot a.me { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .foot button, .foot a { font-size: 12px; color: var(--text-3); }
    /* Seule zone qui défile ; la page routée remplit la hauteur restante. */
    main { min-width: 0; height: 100vh; overflow: auto; display: flex; flex-direction: column; }
    main > :not(header):not(router-outlet) { flex: 1 0 auto; display: block; }
    .search-btn { min-width: 220px; justify-content: space-between; color: var(--text-3); }
    .top { position: sticky; top: 0; z-index: 20; flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 20px;
      background: var(--bg); border-bottom: 1px solid var(--border); }
    .top select { min-width: 170px; }
    /* Filtre actif : bien visible. */
    .top select.active { border-color: var(--accent); color: var(--text-1); background: var(--accent-soft); }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
      main { height: auto; min-height: 0; }
      .search-btn { min-width: 0; }
      .nav { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 6px 8px; }
      nav, .foot { display: flex; flex-wrap: wrap; margin: 0; }
      .brand { padding: 4px 12px; }
      nav a, .foot a, .foot button { border-left: 0; border-bottom: 2px solid transparent; padding: 6px 10px; }
      nav a.on { border-bottom-color: var(--accent); }
      .section { display: none; }
    }
  `,
})
export class App {
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly services = signal<ServiceInfo[]>([]);
  protected readonly environments = signal<string[]>([]);
  protected readonly palette = signal(false);
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
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.readUrl());
    this.loadServices();
    setInterval(() => this.loadServices(), 60_000);
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
    this.api.environments().subscribe({ next: (e) => this.environments.set(e), error: () => {} });
  }

  private loadAlerts() {
    if (this.isLogin() || !this.session.me()?.authenticated) return;
    this.api.activeAlerts().subscribe({
      next: (a) => {
        this.firing.set(a.firing);
        this.firingTitle.set(a.items.filter((x) => x.status === 'firing').slice(0, 5).map((x) => x.message ?? x.ruleName).join('\n'));
      },
      error: () => {},
    });
  }

  protected onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.palette.update((v) => !v);
    }
  }

  logout() {
    this.api.logout().subscribe(() => {
      this.session.me.set(null);
      this.router.navigate(['/login']);
    });
  }

  toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('wolflog.theme', next); } catch { /* ignoré */ }
    this.state.refresh();
  }
}
