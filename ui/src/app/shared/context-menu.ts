import { Component, ElementRef, afterNextRender, computed, inject, input, output, signal } from '@angular/core';
import { NavIcon } from './nav-icon';

export interface MenuAction {
  label: string;
  icon?: string;
  /** Texte secondaire, à droite (ex. le filtre ajouté). */
  hint?: string;
  action: () => void;
}

/** Entrée de menu : action, titre de section ou séparateur. */
export type MenuEntry = MenuAction | { section: string } | 'separator';

/**
 * Menu contextuel (clic droit ou bouton « ⋯ ») : placé au pointeur sans sortir de l'écran, fermé par Échap, un clic
 * ailleurs ou le choix d'une action ; flèches haut / bas et Entrée au clavier.
 */
@Component({
  selector: 'wl-context-menu',
  imports: [NavIcon],
  host: {
    '(document:mousedown)': 'outside($event)',
    '(document:keydown)': 'key($event)',
    '(window:resize)': 'closed.emit()',
    '(window:scroll)': 'closed.emit()',
  },
  template: `
    <div class="menu" role="menu" [style.left.px]="pos().x" [style.top.px]="pos().y" (contextmenu)="$event.preventDefault()">
      @for (e of entries(); track $index) {
        @if (e === 'separator') {
          <div class="sep" role="separator"></div>
        } @else if (isSection(e)) {
          <div class="section">{{ e.section }}</div>
        } @else {
          <button type="button" role="menuitem" class="item" [class.on]="active() === $index" (mouseenter)="active.set($index)" (click)="run(e)">
            <wl-nav-icon [name]="e.icon ?? 'filter'" [size]="14" />
            <span class="label">{{ e.label }}</span>
            @if (e.hint) { <span class="hint mono">{{ e.hint }}</span> }
          </button>
        }
      }
    </div>
  `,
  styles: `
    .menu { position: fixed; z-index: 200; min-width: 240px; max-width: 420px; padding: 5px; border-radius: var(--radius); background: var(--surface-solid);
      backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass);
      border: 1px solid var(--border); box-shadow: var(--shadow-pop, 0 12px 32px rgba(0, 0, 0, .35)); animation: menu-in .16s var(--ease); }
    @keyframes menu-in { from { opacity: 0; transform: scale(.97) translateY(-3px); } }
    .section { padding: 6px 9px 3px; font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--text-3); }
    .sep { height: 1px; margin: 4px 6px; background: var(--border-soft); }
    .item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 9px; border: 0; border-radius: 6px; background: none;
      color: var(--text-1); font: 13px var(--sans); text-align: left; cursor: pointer; }
    .item wl-nav-icon { color: var(--text-3); flex: none; }
    .item.on { background: var(--accent-soft); }
    .item.on wl-nav-icon { color: var(--accent); }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-3); }
  `,
})
export class ContextMenu {
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly entries = input.required<MenuEntry[]>();
  readonly closed = output<void>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly active = signal(-1);
  /** Taille réelle du menu, mesurée après affichage : il reste dans l'écran. */
  private readonly size = signal({ w: 260, h: 0 });
  protected readonly pos = computed(() => {
    const { w, h } = this.size();
    return { x: Math.max(8, Math.min(this.x(), innerWidth - w - 8)), y: Math.max(8, Math.min(this.y(), innerHeight - h - 8)) };
  });

  constructor() {
    afterNextRender(() => {
      const menu = this.el.querySelector('.menu') as HTMLElement | null;
      if (menu) this.size.set({ w: menu.offsetWidth, h: menu.offsetHeight });
    });
  }

  protected isSection(e: MenuEntry): e is { section: string } {
    return typeof e === 'object' && 'section' in e;
  }

  protected run(e: MenuAction) {
    this.closed.emit();
    e.action();
  }

  protected outside(e: MouseEvent) {
    if (!this.el.contains(e.target as Node)) this.closed.emit();
  }

  protected key(e: KeyboardEvent) {
    const actions = this.entries().map((x, i) => (typeof x === 'object' && 'action' in x ? i : -1)).filter((i) => i >= 0);
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closed.emit();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = actions.indexOf(this.active());
      const next = e.key === 'ArrowDown' ? actions[(at + 1) % actions.length] : actions[(at - 1 + actions.length) % actions.length];
      this.active.set(next);
    } else if (e.key === 'Enter' && this.active() >= 0) {
      e.preventDefault();
      this.run(this.entries()[this.active()] as MenuAction);
    }
  }
}
