import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { DashboardInfo } from '../core/models';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { NavIcon } from '../shared/nav-icon';
import { hue } from '../shared/rich-option';

/** Liste des tableaux de bord : cartes en verre, recherche, duplication en un clic. */
@Component({
  selector: 'wl-dashboards',
  imports: [RouterLink, AgoPipe, NavIcon, FormsModule],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Tableaux de bord</h1>
        @if (loaded() && items().length) { <span class="count" title="Nombre de tableaux">{{ items().length }}</span> }
        <span class="spacer"></span>
        @if (items().length > 5) {
          <label class="filter">
            <wl-nav-icon name="search" [size]="14" />
            <input [ngModel]="filter()" (ngModelChange)="filter.set($event)" placeholder="Filtrer les tableaux…" aria-label="Filtrer les tableaux" />
          </label>
        }
        @if (session.canEdit()) { <a class="btn primary" routerLink="/dashboards/new"><wl-nav-icon name="plus" [size]="14" />Nouveau tableau</a> }
      </div>

      @if (!loaded()) {
        <div class="cards" aria-busy="true">
          @for (g of ghosts; track $index; let i = $index) {
            <div class="panel card ghost" [style.--i]="i">
              <div class="top"><i class="skeleton tile-ghost"></i><div class="text"><i class="skeleton" style="width: 60%; height: 13px"></i><i class="skeleton" style="width: 85%; height: 10px"></i></div></div>
              <div class="meta"><i class="skeleton" style="width: 40%; height: 10px"></i></div>
            </div>
          }
        </div>
      } @else if (failed()) {
        <div class="panel empty danger">
          <p>Impossible de charger les tableaux de bord.</p>
          <button class="btn" (click)="load()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button>
        </div>
      } @else if (!items().length) {
        <div class="panel empty">
          <p class="lead">Aucun tableau de bord pour l'instant.</p>
          <p class="small">Rassemblez sur une même page les courbes, chiffres clés, classements et derniers logs que vous consultez le plus.</p>
          @if (session.canEdit()) { <a class="btn primary" routerLink="/dashboards/new"><wl-nav-icon name="plus" [size]="14" />Créer un tableau de bord</a> }
        </div>
      } @else {
        <div class="cards">
          @for (d of shown(); track d.id; let i = $index) {
            <article class="panel card" [style.--i]="i" [style.--hue]="hueOf(d.name)">
              <a class="main" [routerLink]="['/dashboards', d.id]" [attr.aria-label]="'Ouvrir ' + d.name">
                <span class="tile"><wl-nav-icon name="dashboards" [size]="20" /></span>
                <span class="text">
                  <strong class="ellipsis" [title]="d.name">{{ d.name }}</strong>
                  <span class="desc" [class.none]="!d.description" [title]="d.description ?? ''">{{ d.description || 'Sans description' }}</span>
                </span>
                <wl-nav-icon name="chevron-right" class="go" />
              </a>
              <div class="meta small">
                <span><wl-nav-icon name="layers" [size]="13" />{{ d.panels }} panneau{{ d.panels > 1 ? 'x' : '' }}</span>
                <span><wl-nav-icon name="clock" [size]="13" />modifié {{ d.updatedAt | ago }}</span>
                @if (d.visibleTo?.length) {
                  <span class="audience" [title]="'Visible seulement pour : ' + audience(d, 99) + ' (et les administrateurs)'"><wl-nav-icon name="eye" [size]="13" /><em>{{ audience(d, 2) }}</em></span>
                }
              </div>
              @if (session.canEdit()) {
                <a class="dup" routerLink="/dashboards/new" [queryParams]="{ from: d.id }" title="Dupliquer ce tableau" aria-label="Dupliquer ce tableau">
                  <wl-nav-icon name="copy" [size]="14" />
                </a>
              }
            </article>
          } @empty {
            <div class="panel empty small none-found">
              Aucun tableau ne contient « {{ filter() }} ».
              <button class="btn ghost small" (click)="filter.set('')"><wl-nav-icon name="close" [size]="13" />Effacer le filtre</button>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .count { display: inline-grid; place-items: center; min-width: 24px; height: 22px; padding: 0 8px; border-radius: 999px;
      font: 650 11.5px var(--mono); color: var(--accent); background: var(--accent-soft); animation: count-pop .5s var(--spring) .2s backwards; }
    @keyframes count-pop { from { opacity: 0; transform: scale(.5); } }
    .filter { position: relative; display: inline-flex; align-items: center; }
    .filter wl-nav-icon { position: absolute; left: 11px; color: var(--text-3); pointer-events: none; transition: color .2s; }
    .filter:focus-within wl-nav-icon { color: var(--accent); }
    .filter input { width: 230px; padding-left: 32px; }
    .btn wl-nav-icon { transition: transform .4s var(--spring); }
    .btn.primary:hover wl-nav-icon { transform: rotate(90deg); }
    /* Cartes : entrée en cascade, élévation et lueur au survol (transform et opacity uniquement). */
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(290px, 100%), 1fr)); gap: 14px; }
    .card { position: relative; isolation: isolate; display: grid; gap: 12px; padding: 16px; min-width: 0;
      animation: card-in .5s var(--ease) backwards; animation-delay: min(calc(var(--i) * 45ms), 450ms);
      transition: transform .4s var(--spring), border-color .25s; }
    @keyframes card-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
    .card::before { content: ''; position: absolute; inset: -1px; z-index: -1; border-radius: inherit; pointer-events: none; opacity: 0;
      box-shadow: 0 22px 44px -22px hsl(var(--hue) 70% 50% / .75); transition: opacity .3s; }
    .card:not(.ghost):hover { transform: translateY(-3px); }
    .card:not(.ghost):hover::before { opacity: 1; }
    .main { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; color: inherit; }
    .main:hover { text-decoration: none; }
    /* Toute la carte est cliquable ; le bouton « Dupliquer » passe au-dessus. */
    .main::after { content: ''; position: absolute; inset: 0; border-radius: var(--radius); }
    .main:focus-visible { outline: none; }
    .main:focus-visible::after { outline: 2px solid var(--accent); outline-offset: 2px; }
    .tile { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px; color: #fff;
      background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 44%));
      box-shadow: 0 10px 22px -10px hsl(var(--hue) 70% 45% / .9), inset 0 1px 0 rgb(255 255 255 / .35); transition: transform .45s var(--spring); }
    .card:hover .tile { transform: rotate(-8deg) scale(1.08); }
    .text { display: grid; gap: 3px; min-width: 0; }
    .text strong { font-size: 14px; font-weight: 650; }
    .desc { font-size: 12px; color: var(--text-3); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4; }
    .desc.none { font-style: italic; opacity: .7; }
    .go { color: var(--text-3); transition: transform .35s var(--spring), color .2s; }
    .card:hover .go { color: var(--accent); transform: translateX(4px); }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 16px; padding-top: 10px; border-top: 1px solid var(--border-soft); color: var(--text-3); }
    .meta span { display: inline-flex; align-items: center; gap: 6px; }
    /* « Visible pour » : profils choisis (place gardée à droite pour le bouton « Dupliquer »). */
    .meta .audience { min-width: 0; max-width: calc(100% - 36px); }
    .meta .audience wl-nav-icon { color: var(--accent); }
    .meta .audience em { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; }
    .dup { position: absolute; z-index: 1; right: 12px; bottom: 10px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px;
      color: var(--text-2); background: var(--surface-3); opacity: 0; transform: scale(.8);
      transition: opacity .2s, transform .35s var(--spring), color .2s, background-color .2s; }
    .card:hover .dup, .dup:focus-visible { opacity: 1; transform: none; }
    .dup:hover { color: var(--on-accent); background: var(--accent); transform: scale(1.08); }
    .ghost { pointer-events: none; }
    .ghost .top { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: center; }
    .ghost .text { gap: 8px; }
    .tile-ghost { width: 42px; height: 42px; border-radius: 13px; }
    .ghost .meta { border-top-color: transparent; }
    .empty p { margin: 0 auto 8px; max-width: 460px; }
    .empty .lead { font-size: 14px; font-weight: 600; color: var(--text-1); }
    .empty .btn { margin-top: 6px; }
    .none-found { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; gap: 10px; }
    @media (hover: none) { .dup { opacity: 1; transform: none; } }
  `,
})
export class DashboardsPage {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly items = signal<DashboardInfo[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly filter = signal('');
  /** Cartes fantômes pendant le chargement. */
  protected readonly ghosts = [0, 1, 2, 3];
  /** Tableaux dont le nom ou la description contient le texte du filtre. */
  protected readonly shown = computed(() => {
    const f = this.filter().trim().toLowerCase();
    return f ? this.items().filter((d) => (d.name + ' ' + (d.description ?? '')).toLowerCase().includes(f)) : this.items();
  });

  constructor() {
    this.load();
  }

  /** Noms des profils d'accès (« Visible pour »), lus seulement si un tableau en restreint la visibilité. */
  private readonly profileNames = signal<Record<string, string>>({});

  protected load() {
    this.failed.set(false);
    this.loaded.set(false);
    this.api.dashboards().subscribe({
      next: (d) => {
        this.items.set(d);
        this.loaded.set(true);
        if (d.some((x) => x.visibleTo?.length) && !Object.keys(this.profileNames()).length) {
          this.api.dashboardAudiences().subscribe({
            next: (list) => this.profileNames.set(Object.fromEntries(list.map((p) => [p.id, p.name]))),
            error: () => {},
          });
        }
      },
      error: () => {
        this.failed.set(true);
        this.loaded.set(true);
        this.toasts.error('Impossible de charger les tableaux de bord.');
      },
    });
  }

  protected hueOf(name: string) {
    return hue(name);
  }

  /** Profils qui voient le tableau, par leur nom (au plus <max>, puis « +N »). */
  protected audience(d: DashboardInfo, max: number) {
    const ids = d.visibleTo ?? [];
    const names = this.profileNames();
    if (!Object.keys(names).length) return `${ids.length} profil${ids.length > 1 ? 's' : ''}`;
    const known = ids.map((id) => names[id]).filter((n): n is string => !!n);
    if (!known.length) return 'administrateurs seulement';
    return known.slice(0, max).join(', ') + (known.length > max ? ` +${known.length - max}` : '');
  }
}
