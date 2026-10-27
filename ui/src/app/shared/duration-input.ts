import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RichOption } from './rich-option';

export interface DurationPreset {
  value: number;
  label: string;
  hint?: string | null;
  icon?: string;
}

/** Unités proposées pour une durée personnalisée, en multiples de l'unité de base. */
const UNITS = {
  seconds: [{ factor: 1, label: 'secondes' }, { factor: 60, label: 'minutes' }, { factor: 3600, label: 'heures' }, { factor: 86400, label: 'jours' }],
  minutes: [{ factor: 1, label: 'minutes' }, { factor: 60, label: 'heures' }, { factor: 1440, label: 'jours' }],
};

/**
 * Durée : les valeurs courantes dans une liste, et « personnalisée… » pour en saisir une autre (nombre et unité).
 * La valeur est exprimée dans l'unité de base (secondes ou minutes).
 */
@Component({
  selector: 'wl-duration',
  imports: [FormsModule, RichOption],
  template: `
    <select [ngModel]="choice()" (ngModelChange)="pick($event)" [attr.aria-label]="label()">
      @for (p of presets(); track p.value) { <option [value]="p.value" [wlOpt]="p.label" [icon]="p.icon ?? icon()" [desc]="p.hint ?? null"></option> }
      <option value="custom" wlOpt="personnalisée…" icon="edit" desc="Une durée au choix"></option>
    </select>
    @if (custom()) {
      <span class="custom" animate.enter="custom-in">
        <input type="number" class="num" min="1" step="1" [ngModel]="amount()" (ngModelChange)="setAmount(+$event)" [attr.aria-label]="label() + ' : nombre'" />
        <select [ngModel]="unit()" (ngModelChange)="setUnit(+$event)" [attr.aria-label]="label() + ' : unité'">
          @for (u of units(); track u.factor) { <option [value]="u.factor">{{ u.label }}</option> }
        </select>
      </span>
    }
  `,
  styles: `
    :host { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .custom { display: inline-flex; align-items: center; gap: 6px; }
    .num { width: 76px; }
    .custom-in { animation: custom-in .3s var(--spring) backwards; }
    @keyframes custom-in { from { opacity: 0; transform: translateX(-6px) scale(.96); } }
  `,
})
export class DurationInput {
  /** Valeur dans l'unité de base. */
  readonly value = input.required<number>();
  readonly base = input<'seconds' | 'minutes'>('minutes');
  readonly presets = input.required<DurationPreset[]>();
  readonly min = input(1);
  readonly max = input<number | null>(null);
  readonly icon = input('clock');
  readonly label = input('Durée');
  readonly valueChange = output<number>();

  private readonly askedCustom = signal(false);
  private readonly chosenUnit = signal<number | null>(null);
  protected readonly units = computed(() => UNITS[this.base()]);
  protected readonly custom = computed(() => this.askedCustom() || !this.presets().some((p) => p.value === this.value()));
  protected readonly choice = computed(() => (this.custom() ? 'custom' : this.value()));
  /** Unité affichée : celle choisie, sinon la plus grande qui donne un nombre entier. */
  protected readonly unit = computed(() => {
    const chosen = this.chosenUnit();
    if (chosen) return chosen;
    const v = this.value();
    return [...this.units()].reverse().find((u) => v >= u.factor && v % u.factor === 0)?.factor ?? 1;
  });
  protected readonly amount = computed(() => +(this.value() / this.unit()).toFixed(2));

  protected pick(v: number | string) {
    if (v === 'custom') {
      this.askedCustom.set(true);
      return;
    }
    this.askedCustom.set(false);
    this.chosenUnit.set(null);
    this.valueChange.emit(+v);
  }

  protected setAmount(n: number) {
    if (Number.isFinite(n) && n > 0) this.emit(n * this.unit());
  }

  /** Changer d'unité garde le nombre : 5 minutes → 5 heures. */
  protected setUnit(factor: number) {
    const amount = this.amount();
    this.chosenUnit.set(factor);
    this.emit(amount * factor);
  }

  private emit(value: number) {
    const max = this.max();
    this.valueChange.emit(Math.round(Math.max(this.min(), max === null ? value : Math.min(max, value))));
  }
}
