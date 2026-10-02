import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppState, PRESETS } from '../core/app-state';
import { NavIcon } from './nav-icon';

/**
 * Sélecteur de période (préréglages + plage personnalisée). Menu en verre qui s'ouvre avec un rebond et se referme
 * en fondu (animate.enter / animate.leave), entrées en cascade, coche sur la période active.
 */
@Component({
  selector: 'wl-range-picker',
  imports: [FormsModule, NavIcon],
  template: `
    <div class="picker">
      <button class="btn trigger" (click)="open.set(!open())" [class.on]="open()" [attr.aria-expanded]="open()">
        <wl-nav-icon name="clock" class="clock" />{{ state.label() }}<wl-nav-icon name="chevron" class="chevron" />
      </button>
      @if (open()) {
        <div class="menu" animate.enter="menu-in" animate.leave="menu-out" (click)="$event.stopPropagation()">
          @for (p of presets; track p.from; let i = $index) {
            <button class="item" [style.--i]="i" [class.on]="state.isRelative() && state.from() === p.from" (click)="pick(p.from)">
              <span>{{ p.long }}</span><kbd>{{ p.from }}</kbd><wl-nav-icon name="check" class="tick" />
            </button>
          }
          <div class="custom" [style.--i]="presets.length">
            <label>Du <input type="datetime-local" [(ngModel)]="customFrom" /></label>
            <label>Au <input type="datetime-local" [(ngModel)]="customTo" /></label>
            <button class="btn primary" (click)="applyCustom()">Appliquer</button>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .picker { position: relative; }
    .trigger { gap: 8px; padding: 0 10px 0 12px; }
    .trigger .clock { color: var(--accent); transition: transform .6s var(--spring); }
    .trigger:hover .clock { transform: rotate(-35deg); }
    .trigger .chevron { color: var(--text-3); transition: transform .45s var(--spring), color .25s; }
    .trigger.on .chevron { transform: rotate(180deg); color: var(--accent); }
    .menu { position: absolute; right: 0; top: calc(100% + 8px); z-index: 50; width: 270px; max-width: calc(100vw - 24px); padding: 5px; transform-origin: top right;
      background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass);
      border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow-pop), inset 0 1px 0 var(--highlight); }
    .menu-in { animation: menu-in .4s var(--spring); }
    .menu-out { animation: menu-out .18s ease-in forwards; }
    @keyframes menu-in { from { opacity: 0; transform: translateY(-8px) scale(.95); } }
    @keyframes menu-out { to { opacity: 0; transform: translateY(-6px) scale(.97); } }
    .item, .custom { animation: item-in .4s var(--ease) backwards; animation-delay: calc(var(--i) * 22ms + 40ms); }
    @keyframes item-in { from { opacity: 0; transform: translateY(-6px); } }
    .item { position: relative; display: flex; align-items: center; width: 100%; min-height: 32px; padding: 6px 10px; border: 0; border-radius: 10px;
      background: none; color: var(--text-2); font: 12.5px var(--sans); text-align: left; cursor: pointer;
      transition: background-color .18s, color .18s, transform .3s var(--spring); }
    .item:hover { background: var(--surface-3); color: var(--text-1); transform: translateX(4px); }
    .item:active { transform: translateX(4px) scale(.97); }
    .item kbd { margin-left: auto; opacity: .55; transition: opacity .2s; }
    .item:hover kbd, .item.on kbd { opacity: 1; }
    .item .tick { margin-left: 8px; color: var(--accent); opacity: 0; transform: scale(.4); transition: opacity .2s, transform .4s var(--spring); }
    .item.on { color: var(--text-1); font-weight: 600;
      background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 24%, transparent), color-mix(in srgb, var(--accent) 4%, transparent)); }
    .item.on .tick { opacity: 1; transform: scale(1); }
    .custom { display: grid; gap: 8px; padding: 10px 10px 6px; margin-top: 5px; border-top: 1px solid var(--border-soft); }
    .custom label { display: grid; gap: 4px; font-size: 11px; color: var(--text-3); }
  `,
  host: { '(document:click)': 'open.set(false)', '(document:keydown.escape)': 'open.set(false)', '(click)': '$event.stopPropagation()' },
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
