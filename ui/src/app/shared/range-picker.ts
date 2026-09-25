import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppState, PRESETS } from '../core/app-state';

/** Sélecteur de période (préréglages + plage personnalisée). */
@Component({
  selector: 'wl-range-picker',
  imports: [FormsModule],
  template: `
    <div class="picker">
      <button class="btn" (click)="open.set(!open())" [class.on]="open()">{{ state.label() }}</button>
      @if (open()) {
        <div class="menu" (click)="$event.stopPropagation()">
          @for (p of presets; track p.from) {
            <button class="item" [class.on]="state.isRelative() && state.from() === p.from" (click)="pick(p.from)">{{ p.long }}</button>
          }
          <div class="custom">
            <label>Du <input type="datetime-local" [(ngModel)]="customFrom" /></label>
            <label>Au <input type="datetime-local" [(ngModel)]="customTo" /></label>
            <button class="btn" (click)="applyCustom()">Appliquer</button>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .picker { position: relative; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 50; width: 260px; background: var(--surface-2);
      border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 0; box-shadow: 0 8px 24px rgba(0, 0, 0, .35); }
    .item { display: block; width: 100%; text-align: left; padding: 6px 12px; border: 0; background: none; color: var(--text-2); font: 12.5px var(--sans); cursor: pointer; }
    .item:hover { background: var(--surface-3); color: var(--text-1); }
    .item.on { color: var(--accent); }
    .custom { display: grid; gap: 6px; padding: 8px 12px 6px; margin-top: 4px; border-top: 1px solid var(--border); }
    .custom label { display: grid; gap: 3px; font-size: 11px; color: var(--text-3); }
  `,
  host: { '(document:click)': 'open.set(false)', '(click)': '$event.stopPropagation()' },
})
export class RangePicker {
  protected readonly state = inject(AppState);
  protected readonly presets = PRESETS;
  protected readonly open = signal(false);
  protected customFrom = toLocalInput(new Date(Date.now() - 3600_000));
  protected customTo = toLocalInput(new Date());

  pick(from: string) {
    this.state.setRelative(from);
    this.open.set(false);
  }

  applyCustom() {
    const from = new Date(this.customFrom);
    const to = new Date(this.customTo);
    if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
      this.state.setAbsolute(from, to);
      this.open.set(false);
    }
  }
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
