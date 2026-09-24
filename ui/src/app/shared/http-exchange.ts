import { Component, computed, input, signal } from '@angular/core';
import { formatBytes, parseJson } from '../core/format';

const REQ_HEADER = 'http.request.header.';
const RES_HEADER = 'http.response.header.';
const QUERY = 'http.request.query';

/** Attributs affichés par ce composant, à exclure du tableau générique. */
export function isHttpExchangeAttribute(key: string): boolean {
  return key.startsWith(REQ_HEADER) || key.startsWith(RES_HEADER) || key === 'http.request.body' || key === 'http.response.body' || key === QUERY || key === 'url.query';
}

interface Body {
  text: string;
  kind: string;
  size: number;
  truncated: boolean;
}

function body(raw: string | null, contentType: string | null): Body | null {
  if (!raw) return null;
  const marker = raw.match(/\n… \[tronqué : (\d+) octets au total\]$/);
  let text = marker ? raw.slice(0, marker.index) : raw;
  const total = marker ? Number(marker[1]) : new TextEncoder().encode(raw).length;
  let kind = contentType?.split(';')[0] ?? 'texte';
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      text = JSON.stringify(JSON.parse(trimmed), null, 2);
      kind = 'JSON';
    } catch {
      // JSON coupé par la limite de taille : indenté quand même pour rester lisible.
      text = indentPartialJson(trimmed);
      kind = 'JSON';
    }
  }
  return { text, kind, size: total, truncated: !!marker };
}

/** Indente un JSON éventuellement incomplet (sans l'analyser). */
function indentPartialJson(src: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => '\n' + '  '.repeat(Math.max(0, depth));
  for (const c of src) {
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    switch (c) {
      case '"': inString = true; out += c; break;
      case '{': case '[': depth++; out += c + newline(); break;
      case '}': case ']': depth--; out += newline() + c; break;
      case ',': out += c + newline(); break;
      case ':': out += ': '; break;
      case ' ': case '\n': case '\r': case '\t': break;
      default: out += c;
    }
  }
  return out;
}

/** Requête et réponse HTTP d'un span : ligne de requête, paramètres, en-têtes, corps. */
@Component({
  selector: 'vg-http-exchange',
  template: `
    @if (x(); as e) {
      <div class="exchange">
        <div class="line mono">
          <strong>{{ e.method }}</strong> <span class="url">{{ e.url }}</span>
          @if (e.status) { <span class="status" [class.bad]="e.status >= 400">{{ e.status }}</span> }
        </div>

        <div class="seg">
          <button [class.on]="tab() === 'req'" (click)="tab.set('req')">Requête</button>
          <button [class.on]="tab() === 'res'" (click)="tab.set('res')">Réponse</button>
        </div>

        @if (tab() === 'req' && e.params.length) {
          <h4>Paramètres ({{ e.params.length }})</h4>
          <table class="kv mono">
            @for (p of e.params; track $index) {
              <tr><td>{{ p[0] }}</td><td [class.masked]="p[1] === '***'">{{ p[1] }}</td></tr>
            }
          </table>
        }

        @let side = tab() === 'req' ? e.request : e.response;
        <h4>En-têtes ({{ side.headers.length }})</h4>
        @if (side.headers.length) {
          <table class="kv mono">
            @for (h of side.headers; track h[0]) {
              <tr><td>{{ h[0] }}</td><td [class.masked]="h[1] === '***'">{{ h[1] }}</td></tr>
            }
          </table>
        } @else {
          <p class="muted small">En-têtes non capturés.</p>
        }

        @if (side.body; as b) {
          <div class="body-head">
            <h4>Corps</h4>
            <span class="muted small">{{ b.kind }} · {{ size(b.size) }}</span>
            @if (b.truncated) { <span class="warn small">tronqué : seuls les premiers octets sont conservés</span> }
            <span class="spacer"></span>
            <button class="btn ghost small" (click)="copy(b.text)">{{ copied() ? 'Copié' : 'Copier' }}</button>
          </div>
          <pre class="stack body">{{ b.text }}</pre>
        } @else {
          <h4>Corps</h4>
          <p class="muted small">
            Non enregistré. Par défaut, seuls les échanges en erreur le sont (option <code>Vigil:Http:Bodies</code> : Off, Errors ou All).
          </p>
        }
      </div>
    }
  `,
  styles: `
    .exchange > * + * { margin-top: 8px; }
    .line { font-size: 12.5px; overflow-wrap: anywhere; }
    .line strong { margin-right: 8px; }
    .url { color: var(--text-2); }
    .status { margin-left: 8px; color: var(--ok); font-weight: 600; }
    .status.bad { color: var(--danger); }
    h4 { margin: 12px 0 4px; font-size: 11px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: .05em; }
    .kv { width: 100%; border-collapse: collapse; font-size: 11.5px; table-layout: fixed; }
    .kv td { padding: 2px 0; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--border-soft); }
    .kv td:first-child { width: 36%; color: var(--text-3); padding-right: 12px; }
    .masked { color: var(--text-3); }
    .body-head { display: flex; align-items: baseline; gap: 10px; }
    .body-head h4 { margin-bottom: 0; }
    .body { max-height: 520px; font-size: 11.5px; line-height: 1.5; }
    .warn { color: var(--warn); }
    .btn.small { height: 22px; font-size: 11.5px; padding: 0 8px; }
    p { margin: 0; }
  `,
})
export class HttpExchange {
  readonly attributes = input<string | null>(null);
  protected readonly tab = signal<'req' | 'res'>('req');
  protected readonly copied = signal(false);
  protected readonly size = formatBytes;

  protected readonly x = computed(() => {
    const a = parseJson(this.attributes());
    const str = (k: string) => (a[k] === undefined || a[k] === null ? null : String(a[k]));
    const method = str('http.request.method');
    if (!method) return null;

    // Chaîne complète capturée par Vigil (les SDK OpenTelemetry masquent souvent les valeurs de url.query).
    const query = str(QUERY) ?? str('url.query');
    const port = str('server.port');
    const base =
      str('url.full')?.split('?')[0] ??
      `${str('url.scheme') ? str('url.scheme') + '://' : ''}${str('server.address') ?? ''}${port && !['80', '443'].includes(port) ? ':' + port : ''}${str('url.path') ?? ''}`;
    const params: [string, string][] = [];
    for (const pair of (query ?? '').replace(/^\?/, '').split('&').filter(Boolean)) {
      const i = pair.indexOf('=');
      const decode = (s: string) => {
        try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
      };
      params.push(i < 0 ? [decode(pair), ''] : [decode(pair.slice(0, i)), decode(pair.slice(i + 1))]);
    }
    const headers = (prefix: string) =>
      Object.entries(a)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), String(v)] as [string, string])
        .sort((x, y) => x[0].localeCompare(y[0]));
    const reqHeaders = headers(REQ_HEADER);
    const resHeaders = headers(RES_HEADER);
    const contentType = (h: [string, string][]) => h.find(([k]) => k === 'content-type')?.[1] ?? null;
    return {
      method,
      url: base + (query ? '?' + query.replace(/^\?/, '') : ''),
      params,
      status: Number(a['http.response.status_code']) || null,
      request: { headers: reqHeaders, body: body(str('http.request.body'), contentType(reqHeaders)) },
      response: { headers: resHeaders, body: body(str('http.response.body'), contentType(resHeaders)) },
    };
  });

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
