import { Component, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { formatBytes, parseJson } from '../core/format';
import { Toasts } from '../core/toasts';
import { NavIcon } from './nav-icon';

const REQ_HEADER = 'http.request.header.';
const RES_HEADER = 'http.response.header.';
const QUERY = 'http.request.query';
/** Au-delà, le corps est affiché sans coloration (trop d'éléments à créer pour rester fluide). */
const HIGHLIGHT_MAX = 24_000;

/** Libellés standard des codes de statut les plus courants. */
const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type',
  422: 'Unprocessable Entity', 429: 'Too Many Requests', 499: 'Client Closed Request', 500: 'Internal Server Error', 501: 'Not Implemented',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** Attributs affichés par ce composant, à exclure du tableau générique. */
export function isHttpExchangeAttribute(key: string): boolean {
  return key.startsWith(REQ_HEADER) || key.startsWith(RES_HEADER) || key === 'http.request.body' || key === 'http.response.body' || key === QUERY || key === 'url.query';
}

/** Morceau de corps : clé, chaîne, nombre, booléen ou null JSON (classe j-*), ou texte simple (classe vide). */
interface Token {
  text: string;
  cls: string;
}

interface Body {
  text: string;
  kind: string;
  size: number;
  truncated: boolean;
  /** Corps découpé pour la coloration (un seul morceau sans classe quand il n'est pas coloré). */
  tokens: Token[];
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
  const tokens = kind === 'JSON' && text.length <= HIGHLIGHT_MAX ? highlightJson(text) : [{ text, cls: '' }];
  return { text, kind, size: total, truncated: !!marker, tokens };
}

/** Découpe un JSON indenté en morceaux colorables, sans l'analyser (fonctionne aussi sur un JSON tronqué). */
function highlightJson(src: string): Token[] {
  const out: Token[] = [];
  const re = /("(?:\\.|[^"\\\n])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: src.slice(last, at), cls: '' });
    if (m[1]) {
      out.push({ text: m[1], cls: m[2] ? 'j-key' : 'j-str' });
      if (m[2]) out.push({ text: m[2], cls: '' });
    } else {
      out.push({ text: m[0], cls: m[0] === 'null' ? 'j-null' : m[0] === 'true' || m[0] === 'false' ? 'j-bool' : 'j-num' });
    }
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: '' });
  return out;
}

/** Classe de ton d'un code de statut : succès, redirection, erreur client, erreur serveur. */
function statusTone(code: number): string {
  return code >= 500 ? 'err' : code >= 400 ? 'warn' : code >= 300 ? 'redir' : 'ok';
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

/**
 * Requête et réponse HTTP d'un span : ligne de requête (méthode et statut en pastilles colorées), paramètres,
 * en-têtes, corps (JSON coloré). Changer d'onglet fait glisser le contenu.
 */
@Component({
  selector: 'wl-http-exchange',
  imports: [NavIcon],
  template: `
    @if (x(); as e) {
      <div class="exchange">
        <div class="line">
          <span class="method" [attr.data-m]="e.method">{{ e.method }}</span>
          <span class="url mono">{{ e.url }}</span>
          @if (e.status) {
            <span class="status" [attr.data-c]="tone(e.status)" [title]="'Statut HTTP ' + e.status + (reason(e.status) ? ' (' + reason(e.status) + ')' : '')">
              <i></i>{{ e.status }}@if (reason(e.status); as r) { <span class="reason">{{ r }}</span> }
            </span>
          }
          <button type="button" class="icon" (click)="copyUrl(e.url)" title="Copier l'URL" aria-label="Copier l'URL"><wl-nav-icon name="copy" [size]="13" /></button>
        </div>

        <div class="seg">
          <button type="button" [class.on]="tab() === 'req'" (click)="tab.set('req')"><wl-nav-icon name="arrow-up" [size]="13" />Requête</button>
          <button type="button" [class.on]="tab() === 'res'" (click)="tab.set('res')">
            <wl-nav-icon name="arrow-down" [size]="13" />Réponse@if (e.status) { <i class="dot" [attr.data-c]="tone(e.status)"></i> }
          </button>
        </div>

        @for (side of sides(); track side.key) {
          <div class="side" animate.enter="side-in">
            @if (side.key === 'req' && e.params.length) {
              <h4>Paramètres <span class="count">{{ e.params.length }}</span></h4>
              <table class="kv mono">
                @for (p of e.params; track $index) {
                  <tr>
                    <td [title]="p[0]">{{ p[0] }}</td>
                    <td>@if (p[1] === '***') { <span class="masked" title="Valeur masquée à la capture (donnée sensible)"><wl-nav-icon name="lock" [size]="10" />masqué</span> } @else { {{ p[1] }} }</td>
                  </tr>
                }
              </table>
            }

            <h4>En-têtes <span class="count">{{ side.headers.length }}</span></h4>
            @if (side.headers.length) {
              <table class="kv mono">
                @for (h of side.headers; track h[0]) {
                  <tr>
                    <td [title]="h[0]">{{ h[0] }}</td>
                    <td>@if (h[1] === '***') { <span class="masked" title="Valeur masquée à la capture (donnée sensible)"><wl-nav-icon name="lock" [size]="10" />masqué</span> } @else { {{ h[1] }} }</td>
                  </tr>
                }
              </table>
            } @else {
              <p class="note"><wl-nav-icon name="info" [size]="13" /><span>En-têtes non capturés.</span></p>
            }

            @if (side.body; as b) {
              <div class="body-head">
                <h4>Corps</h4>
                <span class="kind">{{ b.kind }}</span>
                <span class="muted small">{{ size(b.size) }}</span>
                @if (b.truncated) {
                  <span class="trunc small" title="Seuls les premiers octets sont conservés à la capture"><wl-nav-icon name="warning" [size]="12" />tronqué</span>
                }
                <span class="spacer"></span>
                <button type="button" class="btn ghost small" [class.done]="copied()" (click)="copyBody(b.text)">
                  <wl-nav-icon [name]="copied() ? 'check' : 'copy'" [size]="13" />{{ copied() ? 'Copié' : 'Copier' }}
                </button>
              </div>
              <pre class="stack body">@for (t of b.tokens; track $index) {<span [class]="t.cls">{{ t.text }}</span>}</pre>
            } @else {
              <h4>Corps</h4>
              <p class="note">
                <wl-nav-icon name="info" [size]="13" />
                <span>Non enregistré. Par défaut, seuls les échanges en erreur le sont (option <code>Wolflog:Http:Bodies</code> : Off, Errors ou All).</span>
              </p>
            }
          </div>
        }
      </div>
    }
  `,
  styles: `
    .exchange > * + * { margin-top: 10px; }
    .line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; font-size: 12.5px; }
    .method { flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font: 700 10.5px/1 var(--mono);
      letter-spacing: .03em; color: var(--m, var(--text-2)); background: color-mix(in srgb, var(--m, var(--text-3)) 14%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--m, var(--text-3)) 30%, transparent); }
    .method[data-m='GET'] { --m: var(--accent); }
    .method[data-m='POST'] { --m: var(--ok); }
    .method[data-m='PUT'] { --m: var(--warn); }
    .method[data-m='PATCH'] { --m: var(--accent-3); }
    .method[data-m='DELETE'] { --m: var(--danger); }
    .url { flex: 1 1 220px; min-width: 0; color: var(--text-2); overflow-wrap: anywhere; }
    [data-c='ok'] { --tone: var(--ok); }
    [data-c='redir'] { --tone: var(--accent-3); }
    [data-c='warn'] { --tone: var(--warn); }
    [data-c='err'] { --tone: var(--danger); }
    .status { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 9px 0 8px; border-radius: 999px;
      font: 650 11.5px/1 var(--mono); color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 28%, transparent); animation: pop-in .45s var(--spring) backwards; }
    .status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
    .status .reason { font: 500 11px var(--sans); opacity: .85; }
    @keyframes pop-in { from { opacity: 0; transform: scale(.8); } }
    .icon { flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px; background: none;
      color: var(--text-3); cursor: pointer; transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .icon:hover { color: var(--accent); background: var(--accent-soft); }
    .icon:active { transform: scale(.86); }
    .seg button { display: inline-flex; align-items: center; gap: 6px; }
    .seg wl-nav-icon { transition: transform .35s var(--spring); }
    .seg button:hover wl-nav-icon { transform: scale(1.15); }
    .seg .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tone); }
    .side-in { animation: side-in .32s var(--ease) backwards; }
    @keyframes side-in { from { opacity: 0; transform: translateY(6px); } }
    h4 { display: flex; align-items: center; gap: 6px; margin: 12px 0 5px; font-size: 11px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: .05em; }
    .side > h4:first-child { margin-top: 2px; }
    .count { min-width: 18px; padding: 0 6px; border-radius: 999px; font: 600 10px/16px var(--mono); text-align: center; letter-spacing: 0;
      color: var(--text-2); background: var(--surface-3); }
    .kv { width: 100%; border-collapse: collapse; font-size: 11.5px; table-layout: fixed; }
    .kv td { padding: 3px 0; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--border-soft); transition: background-color .15s; }
    .kv tr:last-child td { border-bottom: 0; }
    .kv tr:hover td { background: var(--row-hover); }
    .kv td:first-child { width: 36%; color: var(--text-3); padding: 3px 12px 3px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .masked { display: inline-flex; align-items: center; gap: 4px; height: 16px; padding: 0 7px; border-radius: 999px; font: 500 10.5px var(--sans);
      color: var(--text-3); background: var(--surface-3); vertical-align: middle; }
    .body-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .body-head h4 { margin: 0; }
    .kind { padding: 0 7px; border-radius: 999px; font: 600 10.5px/18px var(--mono); color: var(--accent); background: var(--accent-soft); }
    .trunc { display: inline-flex; align-items: center; gap: 4px; color: var(--warn); }
    .body { max-height: 520px; margin-top: 6px; font-size: 11.5px; line-height: 1.5; }
    .j-key { color: var(--accent); }
    .j-str { color: var(--ok); }
    .j-num { color: var(--warn); }
    .j-bool { color: var(--accent-2); }
    .j-null { color: var(--text-3); font-style: italic; }
    .btn.small { height: 24px; font-size: 11.5px; padding: 0 9px; gap: 5px; }
    .btn.small.done { color: var(--ok); }
    .note { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 8px 10px; border-radius: var(--radius-sm); font-size: 12px; color: var(--text-3);
      background: var(--surface-2); border: 1px dashed var(--border); }
    .note wl-nav-icon { margin-top: 2px; color: var(--accent); }
    p { margin: 0; }
  `,
})
export class HttpExchange implements OnDestroy {
  private readonly toasts = inject(Toasts);
  readonly attributes = input<string | null>(null);
  protected readonly tab = signal<'req' | 'res'>('req');
  protected readonly copied = signal(false);
  protected readonly size = formatBytes;
  protected readonly tone = statusTone;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly x = computed(() => {
    const a = parseJson(this.attributes());
    const str = (k: string) => (a[k] === undefined || a[k] === null ? null : String(a[k]));
    const method = str('http.request.method');
    if (!method) return null;

    // Chaîne complète capturée par Wolflog (les SDK OpenTelemetry masquent souvent les valeurs de url.query).
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

  /** Côté affiché, sous forme de liste d'un élément : changer d'onglet recrée le bloc, qui rejoue son entrée. */
  protected readonly sides = computed(() => {
    const e = this.x();
    if (!e) return [];
    return [this.tab() === 'req' ? { key: 'req', ...e.request } : { key: 'res', ...e.response }];
  });

  protected reason(code: number) {
    return REASONS[code] ?? null;
  }

  protected copyUrl(url: string) {
    navigator.clipboard?.writeText(url).then(
      () => this.toasts.ok('URL copiée', 'copy'),
      () => this.toasts.error('Copie impossible : accès au presse-papiers refusé.'),
    );
  }

  protected copyBody(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => {
        this.copied.set(true);
        if (this.copiedTimer) clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.copied.set(false), 1500);
        this.toasts.ok('Corps copié', 'copy');
      },
      () => this.toasts.error('Copie impossible : accès au presse-papiers refusé.'),
    );
  }

  ngOnDestroy() {
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  }
}
