import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppState, PRESETS } from '../core/state';
import { parseJson } from '../core/format';
import { isHttpExchangeAttribute } from './http-exchange';

/** Sélecteur de période (préréglages + plage personnalisée). */
@Component({
  selector: 'vg-range-picker',
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

/** Tableau clé / valeur d'attributs JSON. */
@Component({
  selector: 'vg-attributes',
  template: `
    @if (entries().length) {
      <table class="kv">
        @for (e of entries(); track e[0]) {
          <tr><td class="k">{{ e[0] }}</td><td class="v">{{ e[1] }}</td></tr>
        }
      </table>
    } @else {
      <div class="muted small">Aucun attribut</div>
    }
  `,
  styles: `
    .kv { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; table-layout: fixed; }
    .kv td { padding: 2px 0; vertical-align: top; }
    .k { color: var(--text-3); width: 38%; padding-right: 12px !important; overflow-wrap: anywhere; }
    .v { color: var(--text-1); overflow-wrap: anywhere; }
  `,
})
export class Attributes {
  readonly json = input<string | null>(null);
  readonly exclude = input<string[]>([]);
  /** Masque les en-têtes et corps HTTP (affichés par vg-http-exchange). */
  readonly hideHttp = input(false);
  protected readonly entries = computed(() => {
    const obj = parseJson(this.json());
    const skip = new Set(this.exclude());
    const hideHttp = this.hideHttp();
    return Object.entries(obj)
      .filter(([k]) => !skip.has(k) && !(hideHttp && isHttpExchangeAttribute(k)))
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string]);
  });
}

/** Niveau de log : texte coloré. */
@Component({
  selector: 'vg-level',
  template: `<span class="lvl" [class]="'lvl lvl-' + level()">{{ short() }}</span>`,
})
export class LevelBadge {
  readonly level = input.required<string>();
  protected readonly short = computed(() => ({ trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' })[this.level()] ?? this.level());
}

/** Bloc de code avec bouton copier. */
@Component({
  selector: 'vg-code',
  template: `
    <div class="code">
      <button class="btn ghost copy" (click)="copy()">{{ copied() ? 'Copié' : 'Copier' }}</button>
      <pre>{{ code() }}</pre>
    </div>
  `,
  styles: `
    .code { position: relative; }
    pre { margin: 0; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; overflow: auto;
      font: 12px/1.55 var(--mono); color: var(--text-1); }
    .copy { position: absolute; top: 4px; right: 4px; height: 24px; font-size: 11.5px; }
  `,
})
export class CodeBlock {
  readonly code = input.required<string>();
  protected readonly copied = signal(false);

  copy() {
    navigator.clipboard?.writeText(this.code()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
