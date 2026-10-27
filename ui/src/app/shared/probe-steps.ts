import { Component, computed, input } from '@angular/core';
import { ProbeStep } from '../core/models';
import { DurPipe } from '../core/pipes/dur-pipe';
import { NavIcon } from './nav-icon';

/** Étapes d'une vérification (connexion, TLS, authentification, envoi, réception), chacune avec sa durée. */
@Component({
  selector: 'wl-probe-steps',
  imports: [DurPipe, NavIcon],
  template: `
    <ol class="steps-list">
      @for (s of steps(); track $index) {
        <li [class.ko]="!s.ok">
          <span class="dot"><wl-nav-icon [name]="s.ok ? 'check' : 'close'" [size]="11" /></span>
          <span class="name">{{ s.name }}</span>
          <span class="detail" [title]="s.detail ?? ''">{{ s.detail }}</span>
          <span class="ms mono">{{ s.durationMs | dur }}</span>
        </li>
      }
      @for (name of skipped(); track name) {
        <li class="skipped"><span class="dot"></span><span class="name">{{ name }}</span><span class="detail">non atteinte</span><span class="ms"></span></li>
      }
    </ol>
  `,
  styles: `
    .steps-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 12.5px; }
    li { display: grid; grid-template-columns: 18px minmax(120px, auto) minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 3px 0; }
    .dot { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; color: var(--on-accent); background: var(--ok); }
    li.ko .dot { background: var(--danger); }
    li.skipped .dot { background: none; box-shadow: inset 0 0 0 1.5px var(--border); }
    .name { font-weight: 600; color: var(--text-1); white-space: nowrap; }
    li.ko .name, li.ko .detail { color: var(--danger); }
    li.skipped .name, li.skipped .detail { color: var(--text-3); font-weight: 400; }
    .detail { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ms { color: var(--text-3); font-size: 11.5px; }
  `,
})
export class ProbeSteps {
  readonly steps = input.required<ProbeStep[]>();
  /** Étapes prévues : celles qui n'ont pas été atteintes (après un échec) sont affichées grisées. */
  readonly expected = input<string[]>([]);
  protected readonly skipped = computed(() => {
    const done = new Set(this.steps().map((s) => s.name));
    return this.expected().filter((n) => !done.has(n));
  });
}
