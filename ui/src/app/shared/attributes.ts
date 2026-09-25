import { Component, computed, input, output } from '@angular/core';
import { parseJson } from '../core/format';
import { isHttpExchangeAttribute } from './http-exchange';

/** Tableau clé / valeur d'attributs JSON. */
@Component({
  selector: 'wl-attributes',
  template: `
    @if (entries().length) {
      <table class="kv">
        @for (e of entries(); track e[0]) {
          <tr>
            <td class="k">{{ e[0] }}</td>
            <td class="v">
              @if (pickable()) {
                <span class="pick" (click)="pick.emit({ key: e[0], value: e[1] })" title="Filtrer sur cette valeur">{{ e[1] }}</span>
              } @else {
                {{ e[1] }}
              }
            </td>
          </tr>
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
  /** Masque les en-têtes et corps HTTP (affichés par wl-http-exchange). */
  readonly hideHttp = input(false);
  /** Valeurs cliquables (ajout au filtre). */
  readonly pickable = input(false);
  readonly pick = output<{ key: string; value: string }>();
  protected readonly entries = computed(() => {
    const obj = parseJson(this.json());
    const skip = new Set(this.exclude());
    const hideHttp = this.hideHttp();
    return Object.entries(obj)
      .filter(([k]) => !skip.has(k) && !(hideHttp && isHttpExchangeAttribute(k)))
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string]);
  });
}
