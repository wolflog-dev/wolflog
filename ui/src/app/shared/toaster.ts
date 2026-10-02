import { Component, inject } from '@angular/core';
import { Toasts } from '../core/toasts';
import { NavIcon } from './nav-icon';

/** Pile de notifications (service Toasts) : entrée élastique, barre de temps restant, clic pour fermer. */
@Component({
  selector: 'wl-toaster',
  imports: [NavIcon],
  template: `
    <div class="stack" aria-live="polite">
      @for (t of toasts.items(); track t.id) {
        <button type="button" class="toast" [class]="t.kind" animate.enter="toast-in" animate.leave="toast-out" (click)="toasts.dismiss(t.id)"
                [style.--d]="t.duration + 'ms'" title="Fermer">
          <span class="icon"><wl-nav-icon [name]="t.icon" /></span>
          <span class="text">{{ t.text }}</span>
          <i class="timer"></i>
        </button>
      }
    </div>
  `,
  styles: `
    .stack { position: fixed; right: 18px; bottom: 18px; z-index: 150; display: grid; gap: 8px; justify-items: end; pointer-events: none; }
    /* Téléphone : notifications sur toute la largeur, en bas. */
    @media (max-width: 760px) { .stack { left: 10px; right: 10px; bottom: 10px; justify-items: stretch; } .toast { max-width: none; } }
    .toast { position: relative; overflow: hidden; display: flex; align-items: center; gap: 10px; max-width: 380px; padding: 10px 14px 12px 10px;
      border: 1px solid var(--border); border-radius: 14px; background: var(--surface-solid); color: var(--text-1); font: 500 13px var(--sans);
      text-align: left; cursor: pointer; pointer-events: auto; box-shadow: var(--shadow-pop), inset 0 1px 0 var(--highlight);
      backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); }
    .icon { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 9px; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 16%, transparent); }
    .ok { --tone: var(--ok); }
    .error { --tone: var(--danger); }
    .info { --tone: var(--accent); }
    .timer { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--tone); opacity: .7; transform-origin: left;
      animation: timer var(--d) linear forwards; }
    @keyframes timer { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    .toast-in { animation: toast-in .5s var(--spring); }
    .toast-out { animation: toast-out .25s ease-in forwards; }
    @keyframes toast-in { from { opacity: 0; transform: translateX(40px) scale(.9); } }
    @keyframes toast-out { to { opacity: 0; transform: translateX(30px) scale(.95); } }
  `,
})
export class Toaster {
  protected readonly toasts = inject(Toasts);
}
