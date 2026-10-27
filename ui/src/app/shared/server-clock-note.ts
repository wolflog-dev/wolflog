import { Component, computed, inject, signal } from '@angular/core';
import { Api } from '../core/api';
import { ServerClock } from '../core/models';
import { NavIcon } from './nav-icon';

/** Décalage UTC lisible : « UTC+1 », « UTC−4:30 ». */
function utc(offsetMinutes: number) {
  const sign = offsetMinutes < 0 ? '−' : '+';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : ''}`;
}

/**
 * Rappel : les heures saisies sont celles de Wolflog (fuseau du serveur), avec un avertissement si le navigateur n'est
 * pas dans le même fuseau.
 */
@Component({
  selector: 'wl-server-clock-note',
  imports: [NavIcon],
  template: `
    @if (clock(); as c) {
      <span class="note" [class.warn]="differs()">
        <wl-nav-icon [name]="differs() ? 'warning' : 'clock'" [size]="13" />
        <span>Heures de Wolflog ({{ zone() }}){{ differs() ? ', différentes de celles de votre navigateur (' + browserZone() + ')' : '' }} : il est {{ time() }}.</span>
      </span>
    }
  `,
  styles: `
    .note { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); }
    .note wl-nav-icon { color: var(--accent); flex: none; }
    .note.warn, .note.warn wl-nav-icon { color: var(--warn); }
  `,
})
export class ServerClockNote {
  protected readonly clock = signal<ServerClock | null>(null);
  protected readonly zone = computed(() => utc(this.clock()?.offsetMinutes ?? 0));
  protected readonly browserZone = computed(() => utc(-new Date().getTimezoneOffset()));
  protected readonly differs = computed(() => !!this.clock() && this.clock()!.offsetMinutes !== -new Date().getTimezoneOffset());
  protected readonly time = computed(() => this.clock()?.local.slice(11, 16) ?? '');

  constructor() {
    inject(Api).clock().subscribe({ next: (c) => this.clock.set(c), error: () => {} });
  }
}
