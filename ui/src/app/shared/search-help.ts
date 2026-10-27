import { Component, ElementRef, inject, input, output, signal } from '@angular/core';
import { NavIcon } from './nav-icon';

export interface SearchExample {
  example: string;
  description: string;
}

/** Aide de la barre de recherche : syntaxe et exemples, ajoutés à la recherche d'un clic. */
@Component({
  selector: 'wl-search-help',
  imports: [NavIcon],
  host: { '(document:mousedown)': 'outside($event)', '(document:keydown.escape)': 'open.set(false)' },
  template: `
    <button type="button" class="help-btn" [class.on]="open()" (click)="open.set(!open())" title="Syntaxe de recherche" aria-label="Syntaxe de recherche">
      <wl-nav-icon name="info" [size]="14" />
    </button>
    @if (open()) {
      <div class="pop" role="dialog" aria-label="Syntaxe de recherche">
        <div class="pop-head"><strong>Recherche</strong><span class="muted small">cliquez un exemple pour l'ajouter</span></div>
        <div class="rows">
          @for (e of examples(); track e.example) {
            <button type="button" class="row" (click)="pick(e.example)"><code>{{ e.example }}</code><span>{{ e.description }}</span></button>
          }
        </div>
        @if (note()) { <p class="note">{{ note() }}</p> }
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; }
    .help-btn { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--surface); color: var(--text-3); cursor: pointer; transition: color .2s, border-color .2s; }
    .help-btn:hover, .help-btn.on { color: var(--accent); border-color: var(--accent); }
    .pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 120; width: min(560px, calc(100vw - 32px)); padding: 10px; border-radius: var(--radius);
      background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); border: 1px solid var(--border); box-shadow: var(--shadow-pop, 0 12px 32px rgba(0, 0, 0, .35)); animation: pop .16s var(--ease); }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px); } }
    .pop-head { display: flex; align-items: baseline; gap: 10px; padding: 2px 4px 8px; }
    .rows { display: grid; gap: 1px; max-height: min(420px, 60vh); overflow: auto; }
    .row { display: grid; grid-template-columns: minmax(170px, auto) minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 5px 6px; border: 0; border-radius: 6px;
      background: none; color: var(--text-2); font: 12.5px var(--sans); text-align: left; cursor: pointer; }
    .row:hover { background: var(--accent-soft); color: var(--text-1); }
    .row code { font: 12px var(--mono); color: var(--accent); white-space: nowrap; }
    .note { margin: 8px 4px 2px; font-size: 12px; color: var(--text-3); }
  `,
})
export class SearchHelp {
  readonly examples = input.required<SearchExample[]>();
  readonly note = input('');
  readonly picked = output<string>();
  protected readonly open = signal(false);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected pick(example: string) {
    this.open.set(false);
    this.picked.emit(example);
  }

  protected outside(e: MouseEvent) {
    if (this.open() && !this.el.contains(e.target as Node)) this.open.set(false);
  }
}
