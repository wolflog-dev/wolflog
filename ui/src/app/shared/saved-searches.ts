import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { SavedSearch, SearchPage } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { NavIcon } from './nav-icon';

/**
 * Recherches enregistrées d'une page : un clic pour ouvrir la liste, un clic pour appliquer.
 * Le service sélectionné fait partie de la recherche ; la période, non (elle reste celle en cours).
 * L'étoile se remplit quand les filtres affichés correspondent à une recherche enregistrée.
 */
@Component({
  selector: 'wl-saved-searches',
  imports: [FormsModule, NavIcon],
  host: { '(document:click)': 'close()', '(click)': '$event.stopPropagation()', '(document:keydown.escape)': 'close()' },
  template: `
    <div class="wrap">
      <button class="btn trigger" type="button" (click)="toggle()" [class.on]="open() || !!active()" [class.active]="!!active()" [attr.aria-expanded]="open()"
              [title]="active() ? 'Recherche enregistrée : ' + active()!.name : 'Recherches enregistrées'">
        <wl-nav-icon name="star" [size]="14" class="star" />
        <span class="label ellipsis">{{ active()?.name ?? 'Enregistrées' }}</span>
        @if (!active() && list().length) { <span class="count">{{ list().length }}</span> }
        <wl-nav-icon name="chevron" [size]="12" class="chevron" />
      </button>
      @if (open()) {
        <div class="menu" animate.leave="menu-out">
          @if (list().length) {
            <div class="title">Recherches enregistrées <span class="count">{{ list().length }}</span></div>
            <div class="items">
              @for (s of list(); track s.id; let i = $index) {
                <div class="item" [class.on]="s.id === active()?.id" [style.--i]="i">
                  <button class="apply" type="button" (click)="use(s)" [title]="describe(s) ? s.name + ' : ' + describe(s) : s.name">
                    <span class="lead"><wl-nav-icon [name]="s.id === active()?.id ? 'check' : 'search'" [size]="13" /></span>
                    <span class="text">
                      <span class="name ellipsis">{{ s.name }}</span>
                      <span class="hint ellipsis">{{ describe(s) || 'aucun filtre' }}</span>
                    </span>
                  </button>
                  @if (s.shared) {
                    <span class="team" [title]="'Partagée avec l’équipe par ' + (s.owner ?? '?')"><wl-nav-icon name="users" [size]="11" />équipe</span>
                  }
                  @if (s.mine || session.isAdmin()) {
                    <button class="del" type="button" (click)="remove(s)" [title]="'Supprimer « ' + s.name + ' »'" [attr.aria-label]="'Supprimer la recherche ' + s.name">
                      <wl-nav-icon name="trash" [size]="13" />
                    </button>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="none">
              <span class="none-icon"><wl-nav-icon name="star" [size]="18" /></span>
              <div>
                <strong>Aucune recherche enregistrée</strong>
                <p>Enregistrez les filtres de cette page pour les retrouver en un clic.</p>
              </div>
            </div>
          }
          <form class="save" (ngSubmit)="save()">
            <label>Enregistrer la recherche actuelle
              <input #nameBox name="name" [(ngModel)]="name" placeholder="Nom, ex. Paiements en erreur" autocomplete="off" />
            </label>
            <div class="current small" [title]="describeParams(full()) || 'Aucun filtre : la recherche enregistrée affichera tout'">
              <wl-nav-icon name="filter" [size]="11" /><span class="ellipsis">{{ describeParams(full()) || 'aucun filtre' }}</span>
            </div>
            @if (session.canEdit()) {
              <label class="check small"><input type="checkbox" class="switch" name="shared" [(ngModel)]="shared" /> Visible par toute l'équipe</label>
            }
            @if (error()) { <p class="err small"><wl-nav-icon name="warning" [size]="12" />{{ error() }}</p> }
            <button class="btn primary" type="submit" [disabled]="!name.trim() || saving()"><wl-nav-icon name="check" [size]="14" />Enregistrer</button>
          </form>
        </div>
      }
    </div>
  `,
  styles: `
    .wrap { position: relative; }
    .trigger { max-width: 240px; gap: 7px; padding: 0 10px 0 11px; }
    .trigger .label { min-width: 0; }
    .trigger .star { color: var(--text-3); transition: color .25s, transform .5s var(--spring); }
    .trigger:hover .star { color: var(--accent); transform: rotate(-18deg) scale(1.12); }
    .trigger.active .star { color: var(--accent); animation: star-pop .5s var(--spring); }
    .trigger.active .star ::ng-deep svg { fill: currentColor; }
    @keyframes star-pop { 40% { transform: scale(1.35) rotate(-12deg); } }
    .trigger .chevron { color: var(--text-3); transition: transform .45s var(--spring), color .25s; }
    .trigger[aria-expanded='true'] .chevron { transform: rotate(180deg); color: var(--accent); }
    .count { min-width: 18px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/17px var(--mono); text-align: center; font-variant-numeric: tabular-nums;
      color: var(--text-2); background: var(--surface-3); }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 60; width: 350px; display: grid; gap: 8px; padding: 6px;
      background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow-pop), inset 0 1px 0 var(--highlight); transform-origin: top right; animation: pop-in .4s var(--spring); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(-8px) scale(.95); } }
    .menu-out { animation: menu-out .18s ease-in forwards; }
    @keyframes menu-out { to { opacity: 0; transform: translateY(-6px) scale(.97); } }
    .title { display: flex; align-items: center; gap: 6px; padding: 6px 8px 0; font-size: 11px; font-weight: 600; color: var(--text-3);
      text-transform: uppercase; letter-spacing: .06em; }
    .items { display: grid; gap: 2px; max-height: 300px; overflow: auto; }
    .item { display: flex; align-items: center; gap: 4px; padding-right: 4px; border-radius: 11px; transition: background-color .18s, transform .3s var(--spring);
      animation: item-in .35s var(--ease) backwards; animation-delay: calc(min(var(--i), 12) * 22ms + 40ms); }
    @keyframes item-in { from { opacity: 0; transform: translateY(-6px); } }
    .item:hover { background: var(--surface-3); transform: translateX(3px); }
    .item.on { background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 4%, transparent)); }
    .apply { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; text-align: left; padding: 6px 8px; border: 0; background: none;
      color: var(--text-1); font: 13px var(--sans); cursor: pointer; }
    .apply:active { transform: scale(.98); }
    .lead { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 13%, transparent); transition: transform .4s var(--spring); }
    .item:hover .lead { transform: scale(1.1) rotate(-6deg); }
    .item.on .lead { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .text { min-width: 0; display: grid; gap: 1px; }
    .name { font-weight: 550; }
    .item.on .name { font-weight: 650; }
    .hint { font: 11px var(--mono); color: var(--text-3); }
    .team { flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 999px; font: 600 10.5px/18px var(--sans);
      color: var(--accent-3); background: color-mix(in srgb, var(--accent-3) 12%, transparent); }
    .del { flex: none; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 8px; background: none;
      color: var(--text-3); cursor: pointer; opacity: 0; transform: scale(.8); transition: opacity .15s, transform .3s var(--spring), color .2s, background-color .2s; }
    .item:hover .del, .del:focus-visible { opacity: 1; transform: none; }
    .del:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .del:active { transform: scale(.85); }
    .none { display: flex; align-items: flex-start; gap: 12px; padding: 12px 10px 4px; animation: item-in .35s var(--ease) .05s backwards; }
    .none-icon { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 13%, transparent); }
    .none strong { font-size: 13px; }
    .none p { margin: 2px 0 0; font-size: 12px; color: var(--text-3); }
    .save { display: grid; gap: 8px; padding: 10px 8px 6px; border-top: 1px solid var(--border-soft); }
    label { display: grid; gap: 5px; font-size: 12px; color: var(--text-2); }
    label:focus-within { color: var(--accent); }
    label.check { display: flex; }
    .current { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--text-3); font-family: var(--mono); font-size: 11px; }
    .current wl-nav-icon { flex: none; }
    .err { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--danger); }
    .save .btn { justify-self: start; }
  `,
})
export class SavedSearches {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  private readonly toasts = inject(Toasts);
  protected readonly session = inject(Session);

  readonly page = input.required<SearchPage>();
  /** Filtres courants de la page (hors service, ajouté automatiquement). */
  readonly params = input.required<Record<string, string>>();
  readonly apply = output<Record<string, string>>();

  protected readonly open = signal(false);
  protected readonly list = signal<SavedSearch[]>([]);
  protected readonly error = signal('');
  protected readonly saving = signal(false);
  protected name = '';
  protected shared = false;
  private readonly nameBox = viewChild<ElementRef<HTMLInputElement>>('nameBox');

  /** Filtres enregistrés : ceux de la page et le service sélectionné. */
  protected readonly full = computed(() => {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.params())) if (v) p[k] = v;
    if (this.state.service()) p['service'] = this.state.service();
    return p;
  });

  /** Recherche enregistrée correspondant exactement aux filtres affichés. */
  protected readonly active = computed(() => {
    const cur = this.full();
    return this.list().find((s) => sameParams(s.params, cur)) ?? null;
  });

  constructor() {
    effect(() => {
      this.page();
      this.load();
    });
  }

  private load() {
    this.api.searches(this.page()).subscribe({ next: (l) => this.list.set(l), error: () => {} });
  }

  protected toggle() {
    this.open.update((v) => !v);
    this.error.set('');
    if (this.open() && !this.list().length) setTimeout(() => this.nameBox()?.nativeElement.focus());
  }

  close() {
    this.open.set(false);
  }

  protected use(s: SavedSearch) {
    const { service, ...rest } = s.params;
    if ((service ?? '') !== this.state.service()) this.state.setService(service ?? '');
    this.apply.emit(rest);
    this.close();
  }

  protected save() {
    const name = this.name.trim();
    if (!name || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.api.saveSearch({ name, page: this.page(), params: this.full(), shared: this.shared }).subscribe({
      next: () => {
        this.toasts.ok(`Recherche « ${name} » enregistrée`, 'star');
        this.name = '';
        this.shared = false;
        this.saving.set(false);
        this.load();
        this.close();
      },
      error: (e) => {
        const message = e?.error?.error ?? 'Enregistrement impossible.';
        this.saving.set(false);
        this.error.set(message);
        this.toasts.error(message);
      },
    });
  }

  protected remove(s: SavedSearch) {
    this.api.deleteSearch(s.id).subscribe({
      next: () => {
        this.toasts.ok(`Recherche « ${s.name} » supprimée`, 'trash');
        this.load();
      },
      error: () => this.toasts.error(`Impossible de supprimer « ${s.name} ».`),
    });
  }

  protected describe(s: SavedSearch) {
    return this.describeParams(s.params);
  }

  protected describeParams(p: Record<string, string>) {
    return describeSearch(p);
  }
}

const LABELS: Record<string, string> = { level: 'niveau ≥', status: 'statut', minMs: 'durée ≥', direction: 'sens', service: 'service', errors: 'erreurs' };

const VALUES: Record<string, string> = {
  todo: 'à traiter', mine: 'assignées à moi', resolved: 'résolues', ignored: 'ignorées', all: 'toutes', out: 'sortantes', in: 'entrantes',
};

export function describeSearch(p: Record<string, string>): string {
  return Object.entries(p)
    .filter(([, v]) => v)
    .map(([k, v]) => (k === 'q' ? v : k === 'errors' ? 'en erreur' : `${LABELS[k] ?? k} ${VALUES[v] ?? v}${k === 'minMs' ? ' ms' : ''}`))
    .join(' · ');
}

function sameParams(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a).filter((k) => a[k]);
  const kb = Object.keys(b).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}
