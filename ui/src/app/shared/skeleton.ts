import { Component, computed, input } from '@angular/core';

/** Chargement : lignes grisées parcourues d'un reflet (à la place de « Chargement… »). <wl-skeleton [rows]="5" /> */
@Component({
  selector: 'wl-skeleton',
  template: `
    @for (w of widths(); track $index) {
      <i class="skeleton" [style.width.%]="w" [style.--i]="$index"></i>
    }
  `,
  styles: `
    :host { display: grid; gap: 10px; padding: 14px 16px; }
    .skeleton { height: 12px; animation: fade-in .4s var(--ease) backwards; animation-delay: calc(var(--i) * 50ms); }
    @keyframes fade-in { from { opacity: 0; } }
  `,
})
export class Skeleton {
  readonly rows = input(4);
  /** Largeurs variées, mais stables d'un affichage à l'autre. */
  protected readonly widths = computed(() => Array.from({ length: this.rows() }, (_, i) => [92, 74, 86, 61, 80, 68][i % 6]));
}
