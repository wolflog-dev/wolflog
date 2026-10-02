import { Component, input } from '@angular/core';
import { NavIcon } from './nav-icon';

/**
 * Statut d'un groupe d'erreurs : pastille teintée avec icône, qui apparaît avec un léger rebond (à l'affichage
 * et à chaque changement de statut). Rien n'est affiché pour une erreur simplement ouverte.
 */
@Component({
  selector: 'wl-error-status',
  imports: [NavIcon],
  template: `
    @switch (status()) {
      @case ('regressed') { <span class="st regressed" title="Marquée résolue, puis revue depuis"><wl-nav-icon name="refresh" [size]="11" />réapparue</span> }
      @case ('resolved') { <span class="st resolved" title="Marquée résolue et pas revue depuis"><wl-nav-icon name="check" [size]="11" />résolue</span> }
      @case ('ignored') { <span class="st ignored" title="Masquée de la vue d'ensemble et de la liste à traiter"><wl-nav-icon name="mute" [size]="11" />ignorée</span> }
    }
  `,
  styles: `
    :host { display: inline-flex; vertical-align: middle; }
    :host(:empty) { display: none; }
    .st { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 8px 0 6px; border-radius: 999px; white-space: nowrap;
      font: 600 10.5px/1 var(--sans); color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 30%, transparent); animation: st-in .45s var(--spring) backwards; }
    .regressed { --tone: var(--danger); }
    .resolved { --tone: var(--ok); }
    .ignored { --tone: var(--text-3); }
    @keyframes st-in { from { opacity: 0; transform: scale(.7); } }
  `,
})
export class ErrorStatusTag {
  readonly status = input<string>('open');
}
