import { Component, computed, input, output } from '@angular/core';
import { describeDays } from '../core/schedule';

/** Jours de la semaine, du lundi au dimanche (valeur : 0 = dimanche … 6 = samedi, comme le serveur). */
const DAYS = [
  { value: 1, short: 'L', name: 'lundi' }, { value: 2, short: 'M', name: 'mardi' }, { value: 3, short: 'M', name: 'mercredi' },
  { value: 4, short: 'J', name: 'jeudi' }, { value: 5, short: 'V', name: 'vendredi' }, { value: 6, short: 'S', name: 'samedi' },
  { value: 0, short: 'D', name: 'dimanche' },
];
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Choix des jours : pastilles L M M J V S D, raccourcis « tous les jours » et « jours ouvrés ». */
@Component({
  selector: 'wl-days',
  template: `
    <span class="days" role="group" [attr.aria-label]="label()">
      @for (d of days; track d.value) {
        <button type="button" class="day" [class.on]="isOn(d.value)" [attr.aria-pressed]="isOn(d.value)" [title]="d.name" (click)="toggle(d.value)">{{ d.short }}</button>
      }
    </span>
    <button type="button" class="link" [class.on]="all()" (click)="set(null)">tous les jours</button>
    <button type="button" class="link" [class.on]="weekdays()" (click)="set(weekdayList)">jours ouvrés</button>
  `,
  styles: `
    :host { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
    .days { display: inline-flex; gap: 4px; }
    .day { width: 30px; height: 30px; padding: 0; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); color: var(--text-2);
      font: 600 12px var(--sans); cursor: pointer; transition: border-color .2s, color .2s, background-color .2s, transform .3s var(--spring); }
    .day:hover { border-color: var(--text-3); color: var(--text-1); transform: translateY(-1px); }
    .day.on { border-color: var(--accent); color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .link { border: 0; padding: 0; background: none; color: var(--text-3); font: 12px var(--sans); cursor: pointer; }
    .link:hover, .link.on { color: var(--accent); }
  `,
})
export class DaysPicker {
  /** Jours cochés ; null ou vide = tous les jours. */
  readonly value = input<number[] | null | undefined>(null);
  readonly label = input('Jours');
  readonly valueChange = output<number[] | null>();

  protected readonly days = DAYS;
  protected readonly weekdayList = WEEKDAYS;
  protected readonly all = computed(() => !this.value()?.length || this.value()!.length === 7);
  protected readonly weekdays = computed(() => describeDays(this.value()) === 'du lundi au vendredi');

  protected isOn(day: number) {
    return this.all() || this.value()!.includes(day);
  }

  protected toggle(day: number) {
    const current = this.all() ? DAYS.map((d) => d.value) : [...this.value()!];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    // Aucun jour n'a pas de sens : on revient à « tous les jours ».
    this.set(next.length === 0 || next.length === 7 ? null : next.sort());
  }

  protected set(days: number[] | null) {
    this.valueChange.emit(days);
  }
}
