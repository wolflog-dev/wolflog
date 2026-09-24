import { Component, computed, input, signal } from '@angular/core';
import { parseJson } from '../core/format';

const REQ_HEADER = 'http.request.header.';
const RES_HEADER = 'http.response.header.';

/** Attributs affichés par ce composant, à exclure du tableau générique. */
export function isHttpExchangeAttribute(key: string): boolean {
  return key.startsWith(REQ_HEADER) || key.startsWith(RES_HEADER) || key === 'http.request.body' || key === 'http.response.body';
}

function pretty(body: string | null): string | null {
  if (!body) return body;
  const trimmed = body.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body; // tronqué ou non JSON : affiché tel quel
  }
}

/** Requête et réponse HTTP d'un span : ligne de requête, en-têtes, corps. */
@Component({
  selector: 'vg-http-exchange',
  template: `
    @if (x(); as e) {
      <div class="exchange">
        <div class="line mono">
          <strong>{{ e.method }}</strong> <span class="url">{{ e.url }}</span>
          @if (e.status) { <span class="status" [class.bad]="e.status >= 400">{{ e.status }}</span> }
        </div>

        <div class="tabs seg">
          <button [class.on]="tab() === 'req'" (click)="tab.set('req')">Requête</button>
          <button [class.on]="tab() === 'res'" (click)="tab.set('res')">Réponse</button>
        </div>

        @let side = tab() === 'req' ? e.request : e.response;
        @if (side.headers.length) {
          <table class="kv mono">
            @for (h of side.headers; track h[0]) {
              <tr><td>{{ h[0] }}</td><td [class.masked]="h[1] === '***'">{{ h[1] }}</td></tr>
            }
          </table>
        } @else {
          <p class="muted small">En-têtes non capturés.</p>
        }
        @if (side.body) {
          <pre class="stack">{{ side.body }}</pre>
        } @else {
          <p class="muted small">
            Corps non enregistré. Par défaut, seuls les échanges en erreur le sont (option <code>Vigil:Http:Bodies</code> : Off, Errors, All).
          </p>
        }
      </div>
    }
  `,
  styles: `
    .exchange > * + * { margin-top: 8px; }
    .line { font-size: 12.5px; overflow-wrap: anywhere; }
    .url { color: var(--text-2); }
    .status { margin-left: 8px; color: var(--ok); font-weight: 600; }
    .status.bad { color: var(--danger); }
    .kv { width: 100%; border-collapse: collapse; font-size: 11.5px; table-layout: fixed; }
    .kv td { padding: 1px 0; vertical-align: top; overflow-wrap: anywhere; }
    .kv td:first-child { width: 38%; color: var(--text-3); padding-right: 12px; }
    .masked { color: var(--text-3); }
    p { margin: 0; }
  `,
})
export class HttpExchange {
  readonly attributes = input<string | null>(null);
  protected readonly tab = signal<'req' | 'res'>('req');

  protected readonly x = computed(() => {
    const a = parseJson(this.attributes());
    const str = (k: string) => (a[k] === undefined || a[k] === null ? null : String(a[k]));
    const method = str('http.request.method');
    if (!method) return null;
    const url =
      str('url.full') ??
      `${str('url.scheme') ? str('url.scheme') + '://' : ''}${str('server.address') ?? ''}${str('server.port') && !['80', '443'].includes(str('server.port')!) ? ':' + str('server.port') : ''}${str('url.path') ?? ''}${str('url.query') ? '?' + str('url.query') : ''}`;
    const headers = (prefix: string) =>
      Object.entries(a)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), String(v)] as [string, string])
        .sort((x, y) => x[0].localeCompare(y[0]));
    return {
      method,
      url,
      status: Number(a['http.response.status_code']) || null,
      request: { headers: headers(REQ_HEADER), body: pretty(str('http.request.body')) },
      response: { headers: headers(RES_HEADER), body: pretty(str('http.response.body')) },
    };
  });
}
