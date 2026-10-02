import { Component, computed, input } from '@angular/core';

const SHORT: Record<string, string> = { trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' };
const NAMES: Record<string, string> = {
  trace: 'trace', debug: 'débogage', info: 'information', warn: 'avertissement', error: 'erreur', fatal: 'fatal (arrêt du processus)',
};

/** Niveau de log : pastille teintée de la couleur du niveau, nom complet en infobulle (tient dans une colonne de 30 px). */
@Component({
  selector: 'wl-level',
  template: `<span [class]="'lvl lvl-' + level()" [title]="'Niveau : ' + name()">{{ short() }}</span>`,
  styles: `
    :host { display: inline-flex; vertical-align: middle; }
    .lvl { display: inline-flex; align-items: center; justify-content: center; height: 16px; padding: 0 4px; border-radius: 6px;
      font-size: 10.5px; line-height: 1; letter-spacing: .02em;
      background: color-mix(in srgb, currentColor 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 22%, transparent); }
    .lvl-trace { background: transparent; }
    .lvl-error, .lvl-fatal { background: color-mix(in srgb, currentColor 18%, transparent); }
  `,
})
export class LevelBadge {
  readonly level = input.required<string>();
  protected readonly short = computed(() => SHORT[this.level()] ?? this.level());
  protected readonly name = computed(() => NAMES[this.level()] ?? this.level());
}
