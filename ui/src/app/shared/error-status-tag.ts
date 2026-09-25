import { Component, input } from '@angular/core';

/** Statut d'un groupe d'erreurs ; rien n'est affiché pour une erreur simplement ouverte. */
@Component({
  selector: 'wl-error-status',
  template: `
    @switch (status()) {
      @case ('regressed') { <span class="tag err" title="Marquée résolue, puis revue depuis">réapparue</span> }
      @case ('resolved') { <span class="tag done" title="Marquée résolue et pas revue depuis">résolue</span> }
      @case ('ignored') { <span class="tag done">ignorée</span> }
    }
  `,
  styles: `.done { color: var(--text-3); }`,
})
export class ErrorStatusTag {
  readonly status = input<string>('open');
}
