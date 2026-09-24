import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, SavedSearch, SearchPage } from '../core/api';
import { AppState, Session } from '../core/state';

/**
 * Recherches enregistrées d'une page : un clic pour ouvrir la liste, un clic pour appliquer.
 * Le service sélectionné fait partie de la recherche ; la période, non (elle reste celle en cours).
 */
@Component({
  selector: 'vg-saved-searches',
  imports: [FormsModule],
  host: { '(document:click)': 'close()', '(click)': '$event.stopPropagation()', '(document:keydown.escape)': 'close()' },
  template: `
    <div class="wrap">
      <button class="btn" type="button" (click)="toggle()" [class.on]="open() || !!active()" [title]="active() ? 'Recherche enregistrée : ' + active()!.name : 'Recherches enregistrées'">
        {{ active()?.name ?? 'Enregistrées' }}@if (!active() && list().length) { <span class="muted">{{ list().length }}</span> }
      </button>
      @if (open()) {
        <div class="menu">
          @if (list().length) {
            <div class="items">
              @for (s of list(); track s.id) {
                <div class="item" [class.on]="s.id === active()?.id">
                  <button class="apply" type="button" (click)="use(s)">
                    <span class="ellipsis">{{ s.name }}</span>
                    <span class="hint ellipsis">{{ describe(s) }}</span>
                  </button>
                  @if (s.shared) { <span class="muted small" [title]="'Partagée par ' + (s.owner ?? '?')">équipe</span> }
                  @if (s.mine || session.isAdmin()) {
                    <button class="del" type="button" (click)="remove(s)" title="Supprimer">Supprimer</button>
                  }
                </div>
              }
            </div>
          } @else {
            <p class="muted small">Aucune recherche enregistrée pour cette page.</p>
          }
          <form class="save" (ngSubmit)="save()">
            <label>Enregistrer la recherche actuelle
              <input #nameBox name="name" [(ngModel)]="name" placeholder="Nom, ex. Paiements en erreur" autocomplete="off" />
            </label>
            <div class="muted small ellipsis" [title]="describeParams(params())">{{ describeParams(params()) || 'aucun filtre' }}</div>
            @if (session.canEdit()) {
              <label class="check small"><input type="checkbox" name="shared" [(ngModel)]="shared" /> Visible par toute l'équipe</label>
            }
            @if (error()) { <p class="danger small">{{ error() }}</p> }
            <button class="btn primary" type="submit" [disabled]="!name.trim()">Enregistrer</button>
          </form>
        </div>
      }
    </div>
  `,
  styles: `
    .wrap { position: relative; }
    .wrap > .btn { max-width: 220px; }
    .wrap > .btn .muted { font-variant-numeric: tabular-nums; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 60; width: 340px; display: grid; gap: 10px; padding: 8px;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0, 0, 0, .35); }
    .items { display: grid; max-height: 300px; overflow: auto; }
    .item { display: flex; align-items: center; gap: 6px; border-radius: 3px; padding-right: 4px; }
    .item:hover, .item.on { background: var(--accent-soft); }
    .apply { flex: 1; min-width: 0; display: grid; text-align: left; padding: 5px 8px; border: 0; background: none; color: var(--text-1); font: 13px var(--sans); cursor: pointer; }
    .hint { font: 11.5px var(--mono); color: var(--text-3); }
    .del { border: 0; background: none; color: var(--text-3); font-size: 11.5px; cursor: pointer; visibility: hidden; }
    .item:hover .del { visibility: visible; }
    .del:hover { color: var(--danger); }
    .save { display: grid; gap: 6px; padding: 8px 4px 2px; border-top: 1px solid var(--border); }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: flex; }
    .save .btn { justify-self: start; }
    p { margin: 0 4px; }
  `,
})
export class SavedSearches {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  protected readonly session = inject(Session);

  readonly page = input.required<SearchPage>();
  /** Filtres courants de la page (hors service, ajouté automatiquement). */
  readonly params = input.required<Record<string, string>>();
  readonly apply = output<Record<string, string>>();

  protected readonly open = signal(false);
  protected readonly list = signal<SavedSearch[]>([]);
  protected readonly error = signal('');
  protected name = '';
  protected shared = false;
  private readonly nameBox = viewChild<ElementRef<HTMLInputElement>>('nameBox');

  private readonly full = computed(() => {
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
    if (!name) return;
    this.api.saveSearch({ name, page: this.page(), params: this.full(), shared: this.shared }).subscribe({
      next: () => {
        this.name = '';
        this.shared = false;
        this.load();
        this.close();
      },
      error: (e) => this.error.set(e?.error?.error ?? 'Enregistrement impossible.'),
    });
  }

  protected remove(s: SavedSearch) {
    this.api.deleteSearch(s.id).subscribe(() => this.load());
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
