import { Component, computed, input } from '@angular/core';

/** Niveau de log : texte coloré. */
@Component({
  selector: 'wl-level',
  template: `<span class="lvl" [class]="'lvl lvl-' + level()">{{ short() }}</span>`,
})
export class LevelBadge {
  readonly level = input.required<string>();
  protected readonly short = computed(() => ({ trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' })[this.level()] ?? this.level());
}
