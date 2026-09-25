import { Component, input, signal } from '@angular/core';

/** Bouton discret qui copie un texte (identifiant de trace, etc.). */
@Component({
  selector: 'wl-copy',
  template: `<button class="copy" (click)="copy($event)" [title]="'Copier ' + text()">{{ done() ? 'copié' : 'copier' }}</button>`,
  styles: `
    .copy { border: 0; background: none; padding: 0 4px; font: 11px var(--sans); color: var(--text-3); cursor: pointer; }
    .copy:hover { color: var(--accent); }
  `,
})
export class CopyText {
  readonly text = input.required<string>();
  protected readonly done = signal(false);

  copy(e: Event) {
    e.stopPropagation();
    navigator.clipboard?.writeText(this.text()).then(() => {
      this.done.set(true);
      setTimeout(() => this.done.set(false), 1200);
    });
  }
}
