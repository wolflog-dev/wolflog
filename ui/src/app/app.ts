import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { Api, ServiceInfo } from './core/api';
import { AppState, Session } from './core/state';
import { RangePicker } from './shared/widgets';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, RangePicker],
  template: `
    @if (isLogin()) {
      <router-outlet />
    } @else {
      <div class="shell">
        <aside class="nav">
          <a class="brand" routerLink="/">vigil</a>
          <nav>
            <a routerLink="/" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }">Vue d'ensemble</a>
            <a routerLink="/logs" routerLinkActive="on">Logs</a>
            <a routerLink="/traces" routerLinkActive="on">Traces</a>
            <a routerLink="/errors" routerLinkActive="on">Erreurs</a>
            <a routerLink="/metrics" routerLinkActive="on">Métriques</a>
          </nav>
          <div class="foot">
            <a routerLink="/system" routerLinkActive="on">Système</a>
            <button (click)="toggleTheme()">Thème clair / sombre</button>
            @if (session.me()?.authEnabled) {
              <button (click)="logout()">Déconnexion</button>
            }
          </div>
        </aside>
        <main>
          <header class="top">
            <select [value]="state.service()" (change)="state.setService($any($event.target).value)" title="Service">
              <option value="">Tous les services</option>
              @for (s of services(); track s.name) {
                <option [value]="s.name">{{ s.name }}</option>
              }
            </select>
            <span class="spacer"></span>
            <label class="check small">
              <input type="checkbox" [checked]="state.autoRefresh()" (change)="state.toggleAutoRefresh()" /> Actualisation auto
            </label>
            <button class="btn" (click)="state.refresh()">Actualiser</button>
            <vg-range-picker />
          </header>
          <router-outlet />
        </main>
      </div>
    }
  `,
  styles: `
    .shell { display: grid; grid-template-columns: 180px 1fr; min-height: 100vh; }
    .nav { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; padding: 12px 0;
      background: var(--surface); border-right: 1px solid var(--border); }
    .brand { font: 700 15px var(--mono); color: var(--text-1); padding: 4px 16px 16px; letter-spacing: -.02em; }
    .brand:hover { text-decoration: none; }
    nav, .foot { display: grid; }
    nav a, .foot a, .foot button { display: block; padding: 6px 16px; color: var(--text-2); font: 13px var(--sans);
      border: 0; border-left: 2px solid transparent; background: none; text-align: left; cursor: pointer; }
    nav a:hover, .foot a:hover, .foot button:hover { color: var(--text-1); text-decoration: none; }
    nav a.on, .foot a.on { color: var(--text-1); border-left-color: var(--accent); background: var(--accent-soft); }
    .foot { margin-top: auto; }
    .foot button, .foot a { font-size: 12px; color: var(--text-3); }
    main { min-width: 0; }
    .top { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 10px; padding: 8px 20px;
      background: var(--bg); border-bottom: 1px solid var(--border); }
    .top select { min-width: 190px; }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      .nav { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 6px 8px; }
      nav, .foot { display: flex; flex-wrap: wrap; margin: 0; }
      .brand { padding: 4px 12px; }
      nav a, .foot a, .foot button { border-left: 0; border-bottom: 2px solid transparent; padding: 6px 10px; }
      nav a.on { border-bottom-color: var(--accent); }
    }
  `,
})
export class App {
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly services = signal<ServiceInfo[]>([]);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => (e as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  protected readonly isLogin = computed(() => this.url().startsWith('/login'));

  constructor() {
    this.loadServices();
    setInterval(() => this.loadServices(), 60_000);
  }

  private loadServices() {
    if (this.isLogin()) return;
    this.api.services({ from: '7d', to: '' }).subscribe({ next: (s) => this.services.set(s), error: () => {} });
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
    try { localStorage.setItem('vigil.theme', next); } catch { /* ignoré */ }
    this.state.refresh();
  }
}
