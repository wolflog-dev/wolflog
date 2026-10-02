import { Component, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { parseJson } from '../core/format';
import { Toasts } from '../core/toasts';
import { isHttpExchangeAttribute } from './http-exchange';
import { NavIcon } from './nav-icon';

/** Attribut prêt à afficher : espace de noms atténué, dernier segment de la clé, valeur et son type (couleur). */
interface Entry {
  key: string;
  ns: string;
  leaf: string;
  value: string;
  type: 'str' | 'num' | 'bool' | 'null' | 'json';
}

/** Au-delà de ce nombre d'attributs, un champ permet de les filtrer. */
const FILTER_FROM = 9;

/**
 * Tableau clé / valeur d'attributs JSON : espace de noms des clés atténué (« http.request. » method), valeurs
 * colorées selon leur type, copie d'une valeur au survol, champ de filtre quand la liste est longue.
 */
@Component({
  selector: 'wl-attributes',
  imports: [NavIcon],
  template: `
    @if (entries().length) {
      @if (entries().length >= filterFrom) {
        <label class="find">
          <wl-nav-icon name="search" [size]="13" />
          <input type="text" [value]="filter()" (input)="filter.set($any($event.target).value)" (keydown.escape)="clearFilter($event)"
                 [placeholder]="'Filtrer les ' + entries().length + ' attributs…'" aria-label="Filtrer les attributs" />
        </label>
      }
      <table class="kv">
        @for (e of shown(); track e.key) {
          <tr [class.copied]="copied() === e.key">
            <td class="k" [title]="e.key"><span class="ns">{{ e.ns }}</span>{{ e.leaf }}</td>
            <td class="v" [attr.data-t]="e.type">
              @if (pickable()) {
                <span class="pick" tabindex="0" role="button" (click)="pick.emit({ key: e.key, value: e.value })" (keydown.enter)="pick.emit({ key: e.key, value: e.value })"
                      title="Ajouter au filtre">{{ e.value }}</span>
              } @else {
                {{ e.value }}
              }
            </td>
            <td class="act">
              <button type="button" class="cp" (click)="copy(e)" [title]="'Copier la valeur de ' + e.key" [attr.aria-label]="'Copier la valeur de ' + e.key">
                <wl-nav-icon [name]="copied() === e.key ? 'check' : 'copy'" [size]="12" />
              </button>
            </td>
          </tr>
        } @empty {
          <tr><td colspan="3" class="none">Aucun attribut ne contient « {{ filter() }} ».</td></tr>
        }
      </table>
    } @else {
      <div class="empty small">Aucun attribut</div>
    }
  `,
  styles: `
    :host { display: block; }
    .find { position: relative; display: flex; align-items: center; margin-bottom: 6px; color: var(--text-3); }
    .find wl-nav-icon { position: absolute; left: 10px; pointer-events: none; transition: color .2s, transform .35s var(--spring); }
    .find:focus-within wl-nav-icon { color: var(--accent); transform: scale(1.1); }
    .find input { width: 100%; height: 28px; padding-left: 30px; font: 12px var(--mono); }
    .kv { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; table-layout: fixed; }
    .kv td { padding: 3px 0; vertical-align: top; border-bottom: 1px solid var(--border-soft); transition: background-color .15s; }
    .kv tr:last-child td { border-bottom: 0; }
    .kv tr:hover td { background: var(--row-hover); }
    .k { color: var(--text-2); width: 38%; padding: 3px 12px 3px 4px !important; overflow-wrap: anywhere; border-radius: 6px 0 0 6px; }
    .ns { color: var(--text-3); opacity: .8; }
    .v { color: var(--text-1); overflow-wrap: anywhere; }
    .v[data-t='num'] { color: var(--accent-3); }
    .v[data-t='bool'] { color: var(--accent-2); }
    .v[data-t='null'] { color: var(--text-3); font-style: italic; }
    .v[data-t='json'] { color: var(--text-2); }
    .pick { padding: 0 2px; }
    .act { width: 26px; text-align: right; border-radius: 0 6px 6px 0; }
    .cp { display: inline-grid; place-items: center; width: 20px; height: 18px; padding: 0; border: 0; border-radius: 6px; background: none;
      color: var(--text-3); cursor: pointer; opacity: 0; transform: scale(.8); transition: opacity .15s, transform .3s var(--spring), color .2s, background-color .2s; }
    tr:hover .cp, .cp:focus-visible, tr.copied .cp { opacity: 1; transform: none; }
    .cp:hover { color: var(--accent); background: var(--accent-soft); }
    .cp:active { transform: scale(.85); }
    tr.copied .cp { color: var(--ok); }
    .none { padding: 10px 4px !important; color: var(--text-3); font-family: var(--sans); }
    .empty.small { padding: 10px 4px; text-align: left; }
  `,
})
export class Attributes implements OnDestroy {
  private readonly toasts = inject(Toasts);
  readonly json = input<string | null>(null);
  readonly exclude = input<string[]>([]);
  /** Masque les en-têtes et corps HTTP (affichés par wl-http-exchange). */
  readonly hideHttp = input(false);
  /** Valeurs cliquables (ajout au filtre). */
  readonly pickable = input(false);
  readonly pick = output<{ key: string; value: string }>();

  protected readonly filterFrom = FILTER_FROM;
  protected readonly filter = signal('');
  /** Clé dont la valeur vient d'être copiée (coche affichée un instant). */
  protected readonly copied = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly entries = computed<Entry[]>(() => {
    const obj = parseJson(this.json());
    const skip = new Set(this.exclude());
    const hideHttp = this.hideHttp();
    return Object.entries(obj)
      .filter(([k]) => !skip.has(k) && !(hideHttp && isHttpExchangeAttribute(k)))
      .map(([k, v]) => {
        const dot = k.lastIndexOf('.');
        return {
          key: k,
          ns: dot > 0 && dot < k.length - 1 ? k.slice(0, dot + 1) : '',
          leaf: dot > 0 && dot < k.length - 1 ? k.slice(dot + 1) : k,
          value: typeof v === 'string' ? v : JSON.stringify(v),
          type: v === null ? 'null' : typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'bool' : typeof v === 'object' ? 'json' : 'str',
        };
      });
  });

  /** Attributs affichés : tous, ou ceux dont la clé ou la valeur contient le texte du filtre. */
  protected readonly shown = computed(() => {
    const f = this.filter().trim().toLowerCase();
    const all = this.entries();
    return f && all.length >= FILTER_FROM ? all.filter((e) => e.key.toLowerCase().includes(f) || e.value.toLowerCase().includes(f)) : all;
  });

  protected clearFilter(e: Event) {
    if (!this.filter()) return;
    e.stopPropagation();
    this.filter.set('');
  }

  protected copy(e: Entry) {
    navigator.clipboard?.writeText(e.value).then(
      () => {
        this.copied.set(e.key);
        if (this.copiedTimer) clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.copied.set(null), 1400);
        this.toasts.ok(`Valeur de ${e.key} copiée`, 'copy');
      },
      () => this.toasts.error('Copie impossible : accès au presse-papiers refusé.'),
    );
  }

  ngOnDestroy() {
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  }
}
