import { Component, computed, inject, input, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { serviceMatches } from '../core/access';
import { NavIcon } from './nav-icon';

/**
 * Choix des services visibles : noms (services connus sur 30 jours, ajoutés en un clic) et motifs avec * (« boutique-* »),
 * en pastilles. Liste vide : tous les services, y compris ceux qui apparaîtront plus tard.
 *   <wl-service-picker [(value)]="services" />
 */
@Component({
  selector: 'wl-service-picker',
  imports: [FormsModule, NavIcon],
  template: `
    <div class="svc-picker">
      <div class="svc-chosen" role="list" aria-label="Services visibles">
        @for (p of value(); track p) {
          <span class="svc-chip" [class.pattern]="p.includes('*')" role="listitem" [title]="describe(p)" animate.enter="svc-in" animate.leave="svc-out">
            <wl-nav-icon [name]="p.includes('*') ? 'filter' : 'server'" [size]="12" />{{ p }}
            @if (!disabled()) {
              <button type="button" class="svc-remove" (click)="remove(p)" [attr.aria-label]="'Retirer ' + p" title="Retirer"><wl-nav-icon name="close" [size]="11" /></button>
            }
          </span>
        } @empty {
          <span class="svc-all"><wl-nav-icon name="layers" [size]="13" />Tous les services</span>
        }
      </div>
      @if (!disabled()) {
        <div class="svc-add">
          <input [ngModel]="draft()" (ngModelChange)="draft.set($event)" (keydown.enter)="$event.preventDefault(); add()" [attr.list]="listId"
                 placeholder="Nom d’un service, ou motif : boutique-*" spellcheck="false" autocomplete="off" aria-label="Service ou motif à ajouter" />
          <datalist [id]="listId">
            @for (s of suggestions(); track s) { <option [value]="s"></option> }
          </datalist>
          <button type="button" class="btn small" (click)="add()" [disabled]="!draft().trim()"><wl-nav-icon name="plus" [size]="13" />Ajouter</button>
        </div>
        @if (draft().includes('*')) {
          <p class="svc-hint">{{ draftMatches() }}</p>
        }
        @if (suggestions().length) {
          <div class="svc-quick" aria-label="Services connus">
            @for (s of suggestions().slice(0, 12); track s) {
              <button type="button" class="svc-suggest" (click)="addValue(s)" [title]="'Ajouter ' + s"><wl-nav-icon name="plus" [size]="11" />{{ s }}</button>
            }
            @if (suggestions().length > 12) { <span class="svc-more">+{{ suggestions().length - 12 }} dans la liste</span> }
          </div>
        }
      }
      <p class="svc-summary">{{ summary() }}</p>
    </div>
  `,
  styles: `
    .svc-picker { display: grid; gap: 8px; min-width: 0; }
    .svc-chosen { display: flex; flex-wrap: wrap; gap: 6px; min-height: 26px; }
    /* Pastilles : styles complets ici (rien d'hérité). */
    .svc-chip { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 4px 0 9px; border-radius: 999px; max-width: 100%;
      font: 550 12px/1 var(--mono); white-space: nowrap; color: var(--text-1); background: var(--accent-soft);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
    .svc-chip wl-nav-icon { color: var(--accent); }
    .svc-chip.pattern { background: color-mix(in srgb, var(--accent-3) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-3) 38%, transparent); }
    .svc-chip.pattern wl-nav-icon { color: var(--accent-3); }
    .svc-remove { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
      color: var(--text-3); background: transparent; transition: color .2s, background-color .2s; }
    .svc-remove:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .svc-all { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; font: 550 12px/1 var(--sans);
      color: var(--text-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border-soft); }
    .svc-all wl-nav-icon { color: var(--ok); }
    .svc-add { display: flex; gap: 8px; min-width: 0; }
    .svc-add input { flex: 1; min-width: 0; font-family: var(--mono); }
    .svc-hint, .svc-summary { margin: 0; font-size: 12px; color: var(--text-3); }
    .svc-quick { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    .svc-suggest { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px 0 7px; border: 1px dashed var(--border);
      border-radius: 999px; font: 500 11.5px/1 var(--mono); color: var(--text-2); background: transparent; cursor: pointer;
      transition: color .2s, border-color .2s, background-color .2s, transform .25s var(--spring); }
    .svc-suggest:hover { color: var(--text-1); border-color: var(--accent); background: var(--accent-soft); }
    .svc-suggest:active { transform: scale(.94); }
    .svc-more { font-size: 11.5px; color: var(--text-3); }
    .svc-in { animation: svc-in .3s var(--spring); }
    .svc-out { animation: svc-out .18s ease-in forwards; }
    @keyframes svc-in { from { opacity: 0; transform: scale(.85); } }
    @keyframes svc-out { to { opacity: 0; transform: scale(.85); } }
  `,
})
export class ServicePicker {
  /** Noms et motifs choisis ; vide : tous les services. */
  readonly value = model<string[]>([]);
  readonly disabled = input(false);

  private readonly api = inject(Api);
  protected readonly listId = 'svc-' + Math.random().toString(36).slice(2, 8);
  protected readonly draft = signal('');
  /** Services connus (30 derniers jours). */
  protected readonly known = signal<string[]>([]);

  /** Services connus pas encore couverts par la liste. */
  protected readonly suggestions = computed(() => {
    const chosen = this.value();
    return this.known().filter((s) => !chosen.length || !serviceMatches(chosen, s));
  });
  protected readonly summary = computed(() => {
    const chosen = this.value();
    if (!chosen.length) return 'Aucune limite : tous les services, y compris ceux qui apparaîtront plus tard.';
    const known = this.known();
    if (!known.length) return 'Seulement ces services (et ceux qui correspondent aux motifs).';
    const matched = known.filter((s) => serviceMatches(chosen, s));
    return `Correspond aujourd’hui à ${matched.length} service${matched.length > 1 ? 's' : ''} sur ${known.length}`
      + (matched.length ? ` : ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? '…' : ''}` : '') + '.';
  });
  protected readonly draftMatches = computed(() => {
    const n = this.known().filter((s) => serviceMatches([this.draft().trim()], s)).length;
    return `Ce motif correspond aujourd’hui à ${n} service${n > 1 ? 's' : ''}.`;
  });

  constructor() {
    this.api.services({ from: '30d', to: '' }).subscribe({ next: (list) => this.known.set(list.map((s) => s.name)), error: () => {} });
  }

  protected describe(pattern: string) {
    if (!pattern.includes('*')) return 'Service ' + pattern;
    const matched = this.known().filter((s) => serviceMatches([pattern], s));
    return `Motif : ${matched.length ? matched.join(', ') : 'aucun service connu pour l’instant'}`;
  }

  protected add() {
    this.addValue(this.draft());
    this.draft.set('');
  }

  protected addValue(raw: string) {
    const value = raw.trim();
    if (!value || value.replace(/\*/g, '') === '') return;
    if (this.value().some((v) => v.toLowerCase() === value.toLowerCase())) return;
    this.value.update((list) => [...list, value]);
  }

  protected remove(pattern: string) {
    this.value.update((list) => list.filter((v) => v !== pattern));
  }
}
