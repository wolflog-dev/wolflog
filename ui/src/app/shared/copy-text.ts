import { Component, OnDestroy, inject, input, signal } from '@angular/core';
import { Toasts } from '../core/toasts';
import { NavIcon } from './nav-icon';

/**
 * Copie dans le presse-papiers. Hors contexte sécurisé (Wolflog servi en http sur le réseau local),
 * l'API Clipboard n'existe pas : repli sur une zone de texte invisible et execCommand.
 */
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const focused = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position: fixed; top: 0; left: 0; opacity: 0; pointer-events: none;';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    focused?.focus();
    if (ok) resolve();
    else reject(new Error('Copie refusée'));
  });
}

/** Bouton discret qui copie un texte (identifiant de trace, mot de passe provisoire…) : l'icône se change en coche. */
@Component({
  selector: 'wl-copy',
  imports: [NavIcon],
  template: `
    <button type="button" class="copy" [class.done]="done()" (click)="copy($event)" [title]="'Copier ' + text()"
            [attr.aria-label]="done() ? 'Copié' : 'Copier'">
      <wl-nav-icon class="i-copy" name="copy" [size]="13" />
      <wl-nav-icon class="i-check" name="check" [size]="13" />
    </button>
  `,
  styles: `
    :host { display: inline-flex; vertical-align: middle; }
    .copy { display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 7px; background: none;
      color: var(--text-3); cursor: pointer; transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .copy:hover { color: var(--accent); background-color: var(--accent-soft); transform: translateY(-1px); }
    .copy:active { transform: scale(.86); }
    /* Les deux icônes se superposent : la copie s'efface en tournant, la coche arrive avec un rebond. */
    .copy wl-nav-icon { grid-area: 1 / 1; transition: opacity .2s, transform .45s var(--spring); }
    .i-check { opacity: 0; transform: scale(.3) rotate(-60deg); }
    .done, .done:hover { color: var(--ok); background-color: color-mix(in srgb, var(--ok) 15%, transparent); }
    .done .i-copy { opacity: 0; transform: scale(.3) rotate(60deg); }
    .done .i-check { opacity: 1; transform: none; }
  `,
})
export class CopyText implements OnDestroy {
  readonly text = input.required<string>();
  private readonly toasts = inject(Toasts);
  protected readonly done = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  copy(e: Event) {
    e.stopPropagation();
    copyToClipboard(this.text()).then(
      () => {
        this.done.set(true);
        this.toasts.info('Copié dans le presse-papiers', 'copy');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.done.set(false), 1600);
      },
      () => this.toasts.error('Copie impossible : le navigateur refuse l’accès au presse-papiers.'),
    );
  }

  ngOnDestroy() {
    clearTimeout(this.timer);
  }
}
