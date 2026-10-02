import { Component, ElementRef, afterNextRender, afterRenderEffect, computed, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { sectionForUrl } from '../core/access';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { SavedSearch } from '../core/models';
import { NavIcon } from './nav-icon';

/** Morceau de libellé, surligné s'il correspond au texte cherché. */
interface Part {
  text: string;
  hit: boolean;
}

interface Item {
  /** Clé stable : une ligne qui reste affichée garde son élément (seules les nouvelles entrent en fondu). */
  id: string;
  label: string;
  parts: Part[];
  hint: string;
  group: string;
  /** Icône au trait ; pour un service, teinte de son avatar (initiales). */
  icon: string;
  hue?: number;
  run: () => void;
}

const PAGES: [string, string, boolean?][] = [
  ["Vue d'ensemble", '/'],
  ['Tableaux de bord', '/dashboards'],
  ['Logs', '/logs'],
  ['Requêtes HTTP', '/requests'],
  ['Traces', '/traces'],
  ['Erreurs à traiter', '/errors'],
  ['Métriques', '/metrics'],
  ['Carte des services', '/map'],
  ['Profils (CPU, mémoire)', '/profiles'],
  ['Audience web', '/audience'],
  ['Clics et défilement (cartes de chaleur)', '/clickmaps'],
  ['Alertes', '/alerts'],
  ['Disponibilité (sondes)', '/uptime'],
  ['Objectifs de service (SLO)', '/slos'],
  ['Nouvelle alerte', '/alerts/new'],
  ['Nouvelle sonde', '/uptime/new'],
  ['Nouvel objectif (SLO)', '/slos/new'],
  ['Nouveau tableau de bord', '/dashboards/new'],
  ['Mon compte', '/account'],
  ['Utilisateurs', '/admin/users', true],
  ['Ajouter un utilisateur', '/admin/users/new', true],
  ["Profils d'accès (parties visibles par profil)", '/admin/access', true],
  ['Clés API et intégration', '/admin/keys', true],
  ['Connecter une application', '/admin/keys/new', true],
  ['Sources (fichiers, IIS, syslog)', '/admin/sources', true],
  ['Ajouter une source', '/admin/sources/new', true],
  ['Ajouter un canal de notification', '/alerts/channels/new', true],
  ['Système', '/system', true],
];

/** Icône de chaque section ; les pages de création prennent un « + ». */
const SECTION_ICONS: [string, string][] = [
  ['/dashboards', 'dashboards'], ['/logs', 'logs'], ['/requests', 'requests'], ['/traces', 'traces'], ['/errors', 'errors'],
  ['/metrics', 'metrics'], ['/map', 'map'], ['/profiles', 'profiles'], ['/audience', 'audience'], ['/clickmaps', 'clickmaps'],
  ['/alerts', 'alerts'], ['/uptime', 'uptime'], ['/slos', 'slos'], ['/account', 'account'], ['/admin/users', 'users'],
  ['/admin/keys', 'keys'], ['/admin/sources', 'sources'], ['/system', 'system'], ['/admin/access', 'id-card'],
];

function pageIcon(path: string): string {
  if (path.endsWith('/new')) return 'plus';
  if (path === '/') return 'overview';
  return SECTION_ICONS.find(([p]) => path.startsWith(p))?.[1] ?? 'page';
}

const SEARCH_PAGES: Record<string, [string, string]> = {
  logs: ['/logs', 'Logs'], requests: ['/requests', 'Requêtes'], traces: ['/traces', 'Traces'], errors: ['/errors', 'Erreurs'],
};

function norm(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Découpe un libellé autour de la première correspondance (sans tenir compte des accents ni de la casse). */
function highlight(label: string, query: string): Part[] {
  if (!query) return [{ text: label, hit: false }];
  // Position dans le texte normalisé → position dans le libellé d'origine (un caractère accentué peut se décomposer).
  let normalized = '';
  const origin: number[] = [];
  for (let i = 0; i < label.length; i++) {
    const n = norm(label[i]);
    normalized += n;
    for (let k = 0; k < n.length; k++) origin.push(i);
  }
  const at = normalized.indexOf(query);
  if (at < 0) return [{ text: label, hit: false }];
  const start = origin[at];
  const end = origin[at + query.length - 1] + 1;
  return [
    { text: label.slice(0, start), hit: false },
    { text: label.slice(start, end), hit: true },
    { text: label.slice(end), hit: false },
  ].filter((p) => p.text);
}

/** Initiales d'un nom de service : « Wolflog.Demo » → « WD ». */
function initials(label: string): string {
  const parts = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Teinte stable dérivée du nom (même calcul que les avatars des listes déroulantes). */
function hue(label: string): number {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * Recherche globale (Ctrl+K) : un texte, un identifiant de trace, une page, un tableau, un service ou une métrique,
 * et Entrée pour y aller. Le plus court chemin vers une information. Icône par catégorie, correspondance surlignée,
 * sélection qui glisse d'une ligne à l'autre (clavier ou souris).
 */
@Component({
  selector: 'wl-command-palette',
  imports: [FormsModule, NavIcon],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <div class="palette panel" role="dialog" aria-modal="true" aria-label="Recherche globale">
      <div class="search">
        <wl-nav-icon class="glass-icon" name="search" [size]="18" />
        <input #box class="input" [ngModel]="text()" (ngModelChange)="typed($event)" (keydown)="key($event)"
               placeholder="Rechercher un texte, un identifiant de trace, une page, un service…" autocomplete="off" spellcheck="false"
               role="combobox" aria-expanded="true" aria-controls="palette-items" aria-autocomplete="list"
               [attr.aria-activedescendant]="items().length ? 'palette-item-' + index() : null" />
        @if (text()) {
          <button type="button" class="clear" (click)="clear()" title="Effacer" aria-label="Effacer la recherche" animate.enter="clear-in">
            <wl-nav-icon name="close" [size]="13" />
          </button>
        }
        <kbd class="esc" (click)="close.emit()" title="Fermer">Échap</kbd>
      </div>
      <div class="items" #list id="palette-items" role="listbox" aria-label="Résultats">
        <i class="cursor" #cursor aria-hidden="true"></i>
        @for (item of items(); track item.id; let i = $index) {
          @if (i === 0 || items()[i - 1].group !== item.group) { <div class="group" role="presentation">{{ item.group }}</div> }
          <button type="button" class="item" [id]="'palette-item-' + i" role="option" [attr.aria-selected]="i === index()" [attr.data-i]="i"
                  [class.on]="i === index()" [style.--i]="i" tabindex="-1" (mouseenter)="hover(i)" (click)="go(item)">
            @if (item.hue !== undefined) {
              <span class="lead avatar" [style.--hue]="item.hue">{{ initialsOf(item.label) }}</span>
            } @else {
              <span class="lead"><wl-nav-icon [name]="item.icon" [size]="15" /></span>
            }
            <span class="label ellipsis" [title]="item.label.length > 56 ? item.label : ''">@for (p of item.parts; track $index) {<span [class.hit]="p.hit">{{ p.text }}</span>}</span>
            <span class="hint" [class.path]="item.hint.startsWith('/')">{{ item.hint }}</span>
            <wl-nav-icon class="enter" name="arrow-right" [size]="13" />
          </button>
        } @empty {
          <div class="none">
            <span class="none-icon"><wl-nav-icon name="search" [size]="20" /></span>
            <strong>Aucun résultat</strong>
            <span>Essayez un nom de page, de service, de tableau de bord ou un identifiant de trace.</span>
          </div>
        }
      </div>
      <div class="foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span>
        <span><kbd>↵</kbd> ouvrir</span>
        <span><kbd>Échap</kbd> fermer</span>
        <span class="spacer"></span>
        <span class="count">{{ items().length }} résultat{{ items().length > 1 ? 's' : '' }}</span>
      </div>
    </div>
  `,
  styles: `
    /* Voile : la couleur de fond du thème, floutée (sombre en thème sombre, clair en thème clair). */
    .backdrop { position: fixed; inset: 0; z-index: 90; background: color-mix(in srgb, var(--bg) 55%, transparent);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); animation: fade-in .2s ease-out; }
    @keyframes fade-in { from { opacity: 0; } }
    .palette { position: fixed; top: 12vh; left: 0; right: 0; z-index: 91; display: flex; flex-direction: column; width: min(640px, calc(100% - 32px));
      max-height: 76vh; margin: 0 auto; overflow: hidden; border-radius: 20px; box-shadow: var(--shadow-pop), inset 0 1px 0 var(--highlight);
      animation: palette-in .45s var(--spring); }
    @keyframes palette-in { from { opacity: 0; transform: translateY(-14px) scale(.97); } }

    .search { display: flex; align-items: center; gap: 10px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--border-soft); }
    .glass-icon { color: var(--accent); animation: icon-in .6s var(--spring) .1s backwards; }
    @keyframes icon-in { from { opacity: 0; transform: scale(.4) rotate(-40deg); } }
    .input { flex: 1; height: 56px; padding: 0; border: 0; border-radius: 0; background: transparent; font-size: 15.5px; }
    .input:hover { border-color: transparent; }
    .input:focus { box-shadow: none; transform: none; background: transparent; }
    .clear { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
      color: var(--text-2); background: var(--surface-3); transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .clear:hover { color: var(--text-1); background: color-mix(in srgb, var(--danger) 25%, transparent); transform: rotate(90deg); }
    .clear-in { animation: clear-in .35s var(--spring); }
    @keyframes clear-in { from { opacity: 0; transform: scale(.4); } }
    .esc { cursor: pointer; transition: color .2s, border-color .2s; }
    .esc:hover { color: var(--accent); border-color: var(--accent); }

    .items { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 6px; scroll-padding: 6px; }
    .group { display: flex; align-items: center; gap: 10px; padding: 10px 10px 5px; font: 650 10.5px var(--sans); color: var(--text-3);
      text-transform: uppercase; letter-spacing: .08em; }
    .group::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); }
    /* Sélection : une seule plaque qui glisse jusqu'à la ligne active (transform). */
    .cursor { position: absolute; z-index: 0; top: 0; left: 6px; right: 6px; height: 40px; border-radius: 11px; pointer-events: none; opacity: 0;
      background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 5%, transparent));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent), inset 3px 0 0 var(--accent);
      transition: transform .32s var(--spring), opacity .2s; }
    .item { position: relative; z-index: 1; display: flex; align-items: center; gap: 11px; width: 100%; min-height: 40px; padding: 6px 10px;
      border: 0; border-radius: 11px; background: none; color: var(--text-2); font: 13px var(--sans); text-align: left; cursor: pointer;
      transition: color .15s; animation: item-in .35s var(--ease) backwards; animation-delay: calc(min(var(--i), 14) * 14ms); }
    @keyframes item-in { from { opacity: 0; transform: translateY(-4px); } }
    .item.on { color: var(--text-1); }
    .lead { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--accent); background: var(--accent-soft);
      transition: transform .4s var(--spring), color .2s, background-color .2s, box-shadow .2s; }
    .item.on .lead { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); transform: scale(1.06) rotate(-5deg);
      box-shadow: 0 6px 14px -6px var(--accent); }
    .lead.avatar, .item.on .lead.avatar { border-radius: 50%; color: #fff; font: 700 10px/1 var(--sans);
      background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%)); }
    .item.on .lead.avatar { box-shadow: 0 0 0 2px var(--surface-solid), 0 0 0 3.5px hsl(var(--hue) 70% 55%); }
    .label { flex: 1; min-width: 0; }
    .hit { color: var(--accent); font-weight: 650; border-radius: 3px; background: color-mix(in srgb, var(--accent) 14%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 14%, transparent); }
    .hint { flex: none; max-width: 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); font-size: 11.5px; }
    .hint.path { font-family: var(--mono); font-size: 11px; }
    .enter { flex: none; color: var(--accent); opacity: 0; transform: translateX(-6px); transition: opacity .2s, transform .35s var(--spring); }
    .item.on .enter { opacity: 1; transform: none; }

    .none { display: grid; justify-items: center; gap: 4px; padding: 28px 16px; text-align: center; color: var(--text-3); font-size: 12.5px; }
    .none strong { color: var(--text-1); font-size: 13.5px; }
    .none-icon { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 6px; border-radius: 13px; color: var(--accent);
      background: var(--accent-soft); }

    .foot { display: flex; align-items: center; gap: 14px; padding: 9px 14px; border-top: 1px solid var(--border-soft); color: var(--text-3); font-size: 11.5px; }
    .foot span { display: inline-flex; align-items: center; gap: 4px; }
    .foot kbd { min-width: 20px; text-align: center; }
    .count { font-variant-numeric: tabular-nums; }
    @media (max-width: 600px) { .foot > span:nth-child(-n + 3) { display: none; } }
  `,
})
export class CommandPalette {
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  readonly close = output<void>();

  protected readonly text = signal('');
  protected readonly index = signal(0);
  private readonly dashboards = signal<{ id: string; name: string }[]>([]);
  private readonly services = signal<string[]>([]);
  private readonly metrics = signal<string[]>([]);
  private readonly searches = signal<SavedSearch[]>([]);
  private readonly session = inject(Session);
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');
  private readonly cursor = viewChild.required<ElementRef<HTMLElement>>('cursor');
  protected readonly initialsOf = initials;
  /** Sélection changée au clavier : la ligne active est ramenée dans la zone visible. */
  private keyboard = false;
  /** Le pointeur a bougé : le survol peut sélectionner (et non un simple défilement de la liste sous la souris). */
  private pointerMoved = false;
  private placed = false;

  constructor() {
    afterNextRender(() => {
      this.box().nativeElement.focus();
      // Écouteur direct (sans détection de changements) : seul le premier mouvement après une touche compte.
      this.list().nativeElement.addEventListener('pointermove', (e) => {
        if (this.pointerMoved) return;
        this.pointerMoved = true;
        const i = (e.target as Element | null)?.closest<HTMLElement>('.item')?.dataset['i'];
        if (i !== undefined) this.hover(+i);
      }, { passive: true });
    });
    // La plaque de sélection suit la ligne active.
    afterRenderEffect(() => {
      this.index();
      this.items();
      const cursor = this.cursor().nativeElement;
      const active = this.list().nativeElement.querySelector<HTMLElement>('.item.on');
      if (!active) {
        cursor.style.opacity = '0';
        return;
      }
      if (!this.placed) cursor.style.transition = 'none';
      cursor.style.height = `${active.offsetHeight}px`;
      cursor.style.transform = `translateY(${active.offsetTop}px)`;
      cursor.style.opacity = '1';
      if (!this.placed) {
        cursor.getBoundingClientRect();
        cursor.style.transition = '';
        this.placed = true;
      }
      // Première ligne : tout en haut, pour garder le titre de son groupe visible.
      if (this.keyboard) {
        if (this.index() === 0) this.list().nativeElement.scrollTop = 0;
        else active.scrollIntoView({ block: 'nearest' });
      }
    });
    // Tableaux et métriques : seulement s'ils font partie du profil d'accès (le serveur refuserait).
    if (this.session.can('dashboards')) this.api.dashboards().subscribe((d) => this.dashboards.set(d));
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
    if (this.session.can('metrics')) this.api.metrics({ from: '24h', to: '' }, '').subscribe((m) => this.metrics.set(m.map((x) => x.name)));
    this.api.searches().subscribe((s) => this.searches.set(s));
  }

  protected readonly items = computed<Item[]>(() => {
    const raw = this.text().trim();
    const t = norm(raw);
    const nav = (path: string, query: Record<string, string> = {}) => () => this.router.navigateByUrl(this.router.createUrlTree([path.split('?')[0]], {
      queryParams: { ...Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? '')), ...query },
    }));
    const list: Item[] = [];
    const add = (item: Omit<Item, 'parts'> & { parts?: Part[] }) => list.push({ ...item, parts: item.parts ?? highlight(item.label, t) });
    /** « texte » mis en avant dans une recherche plein texte. */
    const quoted = (before: string, after: string): Part[] =>
      [{ text: before, hit: false }, { text: raw, hit: true }, { text: after, hit: false }].filter((p) => p.text);

    // Entrées limitées aux parties du profil d'accès (une trace s'ouvre aussi depuis les requêtes HTTP).
    const can = (section: string | string[] | null) => this.session.can(section);
    if (raw) {
      if (/^[0-9a-f]{32}$/i.test(raw) && can(['traces', 'requests'])) {
        add({ id: 'trace', group: 'Aller à', label: `Ouvrir la trace ${raw}`, parts: quoted('Ouvrir la trace ', ''), hint: 'Traces', icon: 'traces',
          run: nav(`/traces/${raw.toLowerCase()}`) });
      }
      const targets: [string, string, string, string][] = [
        ['logs', 'les logs', 'Logs', '/logs'], ['requests', 'les requêtes HTTP', 'Requêtes', '/requests'],
        ['traces', 'les opérations', 'Traces', '/traces'], ['errors', 'les erreurs', 'Erreurs', '/errors'],
      ];
      for (const [id, where, hint, path] of targets) {
        if (can(id)) add({ id: `q:${id}`, group: 'Rechercher', label: `« ${raw} » dans ${where}`, parts: quoted('« ', ` » dans ${where}`), hint, icon: pageIcon(path),
          run: nav(path, { q: raw }) });
      }
    }
    const match = (s: string) => !t || norm(s).includes(t);
    for (const s of this.searches()) {
      const [path, hint] = SEARCH_PAGES[s.page] ?? ['/logs', 'Logs'];
      if (match(s.name) && can(sectionForUrl(path))) {
        add({
          id: `saved:${s.id}`, group: 'Recherches enregistrées', label: s.name, hint, icon: 'star',
          run: () => {
            const { service, ...rest } = s.params;
            if ((service ?? '') !== this.state.service()) this.state.setService(service ?? '');
            this.router.navigate([path], { queryParams: rest });
          },
        });
      }
    }
    for (const [label, path, admin] of PAGES) {
      if (match(label) && (!admin || this.session.isAdmin()) && can(sectionForUrl(path))) add({ id: `page:${path}`, group: 'Pages', label, hint: path, icon: pageIcon(path), run: nav(path) });
    }
    for (const d of this.dashboards()) {
      if (match(d.name)) add({ id: `dash:${d.id}`, group: 'Tableaux de bord', label: d.name, hint: 'tableau', icon: 'dashboards', run: nav(`/dashboards/${d.id}`) });
    }
    for (const s of this.services()) {
      if (match(s)) add({ id: `svc:${s}`, group: 'Services', label: s, hint: 'filtrer sur ce service', icon: 'layers', hue: hue(s), run: () => this.state.setService(s) });
    }
    if (t) {
      for (const m of this.metrics().filter((m) => norm(m).includes(t)).slice(0, 8)) {
        add({ id: `metric:${m}`, group: 'Métriques', label: m, hint: 'métrique', icon: 'chart-line', run: nav('/metrics', { name: m }) });
      }
    }
    return list.slice(0, 40);
  });

  protected typed(value: string) {
    this.text.set(value);
    this.index.set(0);
    this.keyboard = true;
    this.pointerMoved = false;
  }

  protected clear() {
    this.typed('');
    this.box().nativeElement.focus();
  }

  /** Survol d'une ligne : la sélection suit la souris (seulement si elle a bougé). */
  protected hover(i: number) {
    if (!this.pointerMoved) return;
    this.keyboard = false;
    this.index.set(i);
  }

  protected key(e: KeyboardEvent) {
    const n = this.items().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.keyboard = true;
      this.pointerMoved = false;
      this.index.set(e.key === 'ArrowDown' ? Math.min(n - 1, this.index() + 1) : Math.max(0, this.index() - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.items()[this.index()];
      if (item) this.go(item);
    } else if (e.key === 'Escape') {
      this.close.emit();
    }
  }

  protected go(item: Item) {
    item.run();
    this.close.emit();
  }
}
