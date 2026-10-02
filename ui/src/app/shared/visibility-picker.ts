import { Component, computed, inject, linkedSignal, model, signal } from '@angular/core';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { DashboardAudience } from '../core/models';
import { NavIcon } from './nav-icon';

type Mode = 'all' | 'some';

/**
 * « Visible pour » d'un tableau de bord : tout le monde, ou les profils d'accès choisis (pastilles à cocher). Le profil de la
 * personne connectée reste coché (sinon le tableau disparaîtrait pour elle) ; les administrateurs voient toujours tout.
 *   <wl-visibility-picker [(value)]="visibleTo" />
 */
@Component({
  selector: 'wl-visibility-picker',
  imports: [NavIcon],
  template: `
    <div class="vis">
      <div class="seg" role="radiogroup" aria-label="Visible pour">
        <button type="button" role="radio" [class.on]="mode() === 'all'" [attr.aria-checked]="mode() === 'all'" (click)="setMode('all')">Tout le monde</button>
        <button type="button" role="radio" [class.on]="mode() === 'some'" [attr.aria-checked]="mode() === 'some'" (click)="setMode('some')">Profils choisis</button>
      </div>
      @if (mode() === 'some') {
        <div class="vis-list" role="group" aria-label="Profils d'accès qui voient le tableau" animate.enter="vis-in" animate.leave="vis-out">
          @for (p of profiles(); track p.id) {
            <button type="button" class="vis-chip" [class.on]="value().includes(p.id)" [class.locked]="p.id === own()"
                    [attr.aria-pressed]="value().includes(p.id)" [attr.aria-disabled]="p.id === own() || null" [title]="hint(p)" (click)="toggle(p.id)">
              <wl-nav-icon [name]="value().includes(p.id) ? 'check' : p.icon || 'users'" [size]="12" />{{ p.name }}
              @if (p.id === own()) { <span class="vis-own">vous</span> }
            </button>
          } @empty {
            @if (!loaded()) {
              @for (g of [1, 2, 3]; track g) { <i class="skeleton vis-ghost" aria-busy="true"></i> }
            } @else {
              <span class="vis-none">Aucun profil d'accès pour l'instant.</span>
            }
          }
        </div>
      }
      <p class="vis-summary">{{ summary() }}</p>
    </div>
  `,
  styles: `
    .vis { display: grid; justify-items: start; gap: 8px; min-width: 0; }
    .vis-list { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    /* Pastilles à cocher : styles complets ici (rien d'hérité). */
    .vis-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 100%; padding: 0 11px 0 9px; border: 0;
      border-radius: 999px; font: 550 12.5px/1 var(--sans); white-space: nowrap; cursor: pointer; color: var(--text-2);
      background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border);
      transition: color .2s, background-color .2s, box-shadow .2s, transform .25s var(--spring); }
    .vis-chip wl-nav-icon { color: var(--text-3); transition: color .2s; }
    .vis-chip:hover { color: var(--text-1); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, var(--border)); }
    .vis-chip:active:not(.locked) { transform: scale(.94); }
    .vis-chip.on { color: var(--text-1); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
    .vis-chip.on wl-nav-icon { color: var(--accent); }
    .vis-chip.locked { cursor: default; }
    .vis-own { padding: 2px 6px; border-radius: 999px; font: 600 10.5px/1 var(--sans); color: var(--accent); background: var(--surface);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
    .vis-ghost { width: 92px; height: 28px; border-radius: 999px; }
    .vis-none, .vis-summary { margin: 0; font-size: 12px; color: var(--text-3); }
    .vis-in { animation: vis-in .3s var(--ease); }
    .vis-out { animation: vis-out .18s ease-in forwards; }
    @keyframes vis-in { from { opacity: 0; transform: translateY(-4px); } }
    @keyframes vis-out { to { opacity: 0; transform: translateY(-4px); } }
  `,
})
export class VisibilityPicker {
  /** Identifiants des profils qui voient le tableau ; vide : tout le monde. */
  readonly value = model<string[]>([]);

  private readonly api = inject(Api);
  private readonly session = inject(Session);
  protected readonly profiles = signal<DashboardAudience[]>([]);
  protected readonly loaded = signal(false);
  /** Profil de la personne connectée, toujours coché (aucun pour un administrateur, qui voit tout). */
  protected readonly own = computed(() => (this.session.isAdmin() ? null : this.session.me()?.profile?.id ?? null));
  /** « Profils choisis » reste affiché quand on décoche tout (le tableau redevient alors visible pour tout le monde). */
  protected readonly mode = linkedSignal<string[], Mode>({
    source: this.value,
    computation: (value, previous) => (value.length ? 'some' : previous?.value ?? 'all'),
  });
  /** Dernier choix de profils, rendu si l'on revient sur « Profils choisis ». */
  private kept: string[] = [];

  protected readonly summary = computed(() => {
    if (this.mode() === 'all') return 'Tout le monde le voit ; chacun n’y trouve que les panneaux de son profil d’accès.';
    const chosen = this.value();
    const names = this.profiles().filter((p) => chosen.includes(p.id)).map((p) => p.name);
    if (!names.length) return this.loaded() ? 'Aucun profil coché : le tableau reste visible pour tout le monde.' : '';
    return `Seulement pour : ${names.join(', ')}, et les administrateurs (qui voient tout).`;
  });

  constructor() {
    this.api.dashboardAudiences().subscribe({
      next: (list) => {
        this.profiles.set(list);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
  }

  protected setMode(mode: Mode) {
    if (mode === this.mode()) return;
    if (mode === 'all') {
      this.kept = this.value();
      this.mode.set('all');
      this.value.set([]);
      return;
    }
    const own = this.own();
    const restored = this.kept.length ? this.kept : own ? [own] : [];
    this.mode.set('some');
    this.value.set(own && !restored.includes(own) ? [...restored, own] : restored);
  }

  protected toggle(id: string) {
    if (id === this.own()) return;
    this.value.update((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  }

  protected hint(p: DashboardAudience) {
    if (p.id === this.own()) return 'Votre profil : il reste coché, sinon ce tableau disparaîtrait pour vous';
    return p.id === 'all' ? 'Comptes sans profil particulier (« Tout voir »)' : '';
  }
}
