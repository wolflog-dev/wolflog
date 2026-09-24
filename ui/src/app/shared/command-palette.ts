import { Component, ElementRef, computed, inject, output, signal, viewChild, afterNextRender } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { AppState } from '../core/state';

interface Item {
  label: string;
  hint: string;
  group: string;
  run: () => void;
}

const PAGES: [string, string][] = [
  ["Vue d'ensemble", '/'],
  ['Tableaux de bord', '/dashboards'],
  ['Logs', '/logs'],
  ['Requêtes HTTP', '/requests'],
  ['Traces', '/traces'],
  ['Erreurs', '/errors'],
  ['Métriques', '/metrics'],
  ['Système et intégration', '/system'],
];

function norm(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Recherche globale (Ctrl+K) : un texte, un identifiant de trace, une page, un tableau, un service ou une métrique,
 * et Entrée pour y aller. Le plus court chemin vers une information.
 */
@Component({
  selector: 'vg-command-palette',
  imports: [FormsModule],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <div class="palette panel" role="dialog" aria-label="Recherche globale">
      <input #box class="input" [ngModel]="text()" (ngModelChange)="text.set($event); index.set(0)" (keydown)="key($event)"
             placeholder="Rechercher un texte, un identifiant de trace, une page, un service…" autocomplete="off" />
      <div class="items">
        @for (item of items(); track $index; let i = $index) {
          @if (i === 0 || items()[i - 1].group !== item.group) { <div class="group">{{ item.group }}</div> }
          <button class="item" [class.on]="i === index()" (mouseenter)="index.set(i)" (click)="go(item)">
            <span class="ellipsis">{{ item.label }}</span>
            <span class="hint">{{ item.hint }}</span>
          </button>
        } @empty {
          <div class="empty small">Aucun résultat.</div>
        }
      </div>
      <div class="foot small muted"><kbd>↑</kbd> <kbd>↓</kbd> choisir · <kbd>Entrée</kbd> ouvrir · <kbd>Échap</kbd> fermer</div>
    </div>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); z-index: 90; }
    .palette { position: fixed; top: 12vh; left: 50%; transform: translateX(-50%); width: min(620px, calc(100% - 32px)); z-index: 91;
      box-shadow: 0 16px 48px rgba(0, 0, 0, .45); overflow: hidden; }
    .input { width: 100%; height: 46px; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; font-size: 15px; padding: 0 16px; background: transparent; }
    .input:focus { box-shadow: none; border-color: var(--border); }
    .items { max-height: 50vh; overflow: auto; padding: 4px 0; }
    .group { padding: 8px 16px 2px; font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: .05em; }
    .item { display: flex; justify-content: space-between; gap: 16px; width: 100%; padding: 7px 16px; border: 0; background: none; color: var(--text-1);
      font: 13px var(--sans); text-align: left; cursor: pointer; }
    .item.on { background: var(--accent-soft); }
    .hint { color: var(--text-3); font-size: 12px; white-space: nowrap; }
    .foot { padding: 8px 16px; border-top: 1px solid var(--border); }
    .empty { padding: 16px; }
  `,
})
export class CommandPalette {
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  readonly close = output<void>();

  protected readonly text = signal('');
  protected readonly index = signal(0);
  private readonly dashboards = signal<{ id: string; name: string }[]>([]);
  private readonly services = signal<string[]>([]);
  private readonly metrics = signal<string[]>([]);
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  constructor() {
    afterNextRender(() => this.box().nativeElement.focus());
    this.api.dashboards().subscribe((d) => this.dashboards.set(d));
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
    this.api.metrics({ from: '24h', to: '' }, '').subscribe((m) => this.metrics.set(m.map((x) => x.name)));
  }

  protected readonly items = computed<Item[]>(() => {
    const raw = this.text().trim();
    const t = norm(raw);
    const nav = (path: string, query: Record<string, string> = {}) => () => this.router.navigate([path], { queryParams: query });
    const list: Item[] = [];

    if (raw) {
      if (/^[0-9a-f]{32}$/i.test(raw)) list.push({ group: 'Aller à', label: `Ouvrir la trace ${raw}`, hint: 'Traces', run: nav(`/traces/${raw.toLowerCase()}`) });
      list.push(
        { group: 'Rechercher', label: `« ${raw} » dans les logs`, hint: 'Logs', run: nav('/logs', { q: raw }) },
        { group: 'Rechercher', label: `« ${raw} » dans les requêtes HTTP`, hint: 'Requêtes', run: nav('/requests', { q: raw }) },
        { group: 'Rechercher', label: `« ${raw} » dans les opérations`, hint: 'Traces', run: nav('/traces', { q: raw }) },
        { group: 'Rechercher', label: `« ${raw} » dans les erreurs`, hint: 'Erreurs', run: nav('/errors', { q: raw }) },
      );
    }
    const match = (s: string) => !t || norm(s).includes(t);
    for (const [label, path] of PAGES) if (match(label)) list.push({ group: 'Pages', label, hint: path, run: nav(path) });
    for (const d of this.dashboards()) if (match(d.name)) list.push({ group: 'Tableaux de bord', label: d.name, hint: 'tableau', run: nav(`/dashboards/${d.id}`) });
    for (const s of this.services()) {
      if (match(s)) list.push({ group: 'Services', label: s, hint: 'filtrer sur ce service', run: () => this.state.setService(s) });
    }
    if (t) {
      for (const m of this.metrics().filter((m) => norm(m).includes(t)).slice(0, 8)) {
        list.push({ group: 'Métriques', label: m, hint: 'métrique', run: nav('/metrics', { name: m }) });
      }
    }
    return list.slice(0, 40);
  });

  protected key(e: KeyboardEvent) {
    const n = this.items().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.index.set(Math.min(n - 1, this.index() + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.index.set(Math.max(0, this.index() - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.items()[this.index()];
      if (item) this.go(item);
    } else if (e.key === 'Escape') {
      this.close.emit();
    }
  }

  protected go(item: Item) {
    item.run();
    this.close.emit();
  }
}
