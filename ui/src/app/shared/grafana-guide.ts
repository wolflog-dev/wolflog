import { Component, computed, input } from '@angular/core';
import { CodeBlock } from './code-block';
import { CopyText } from './copy-text';
import { NavIcon } from './nav-icon';

/** Mise en place de Grafana : plugin Infinity, source de données Wolflog avec une clé de lecture, exemples de requêtes. */
@Component({
  selector: 'wl-grafana-guide',
  imports: [CodeBlock, CopyText, NavIcon],
  template: `
    <ol class="steps">
      <li>
        <span class="dot"><wl-nav-icon name="download" [size]="13" /></span>
        <div class="body">
          <strong>Installer le plugin « Infinity »</strong> (gratuit, maintenu par Grafana Labs) :
          Administration › Plugins › « Infinity », ou en ligne de commande :
          <wl-code code="grafana cli plugins install yesoreyeram-infinity-datasource" lang="Terminal" />
        </div>
      </li>
      <li>
        <span class="dot"><wl-nav-icon name="database" [size]="13" /></span>
        <div class="body">
          <strong>Ajouter la source de données</strong> : Connections › Data sources › Infinity, puis
          <em>Authentication</em> : API Key, clé <code>x-wolflog-key</code>, valeur ci-dessous, « In header » ;
          <em>Allowed hosts</em> : <code>{{ endpoint() }}</code>. Ou par fichier de configuration (provisioning) :
          <wl-code [code]="provisioning()" />
        </div>
      </li>
      <li>
        <span class="dot"><wl-nav-icon name="chart-line" [size]="13" /></span>
        <div class="body">
          <strong>Créer un panneau</strong> : source « Wolflog », Type JSON, Parser Backend, URL au choix :
          <div class="urls">
            @for (u of urls(); track u.label; let i = $index) {
              <div class="url" [style.--i]="i">
                <span class="label"><wl-nav-icon [name]="u.icon" [size]="13" />{{ u.label }}</span>
                <code class="ellipsis" [title]="u.url">{{ u.url }}</code>
                <wl-copy [text]="u.url" />
              </div>
            }
          </div>
          <p class="muted small">Colonne <code>time</code> : choisissez le format « Time series » ; les autres URL renvoient des tableaux.
            Filtres communs : <code>service</code>, <code>env</code>. Un tableau de bord d'exemple est fourni dans
            <code>deploy/grafana/wolflog-dashboard.json</code>.</p>
        </div>
      </li>
    </ol>
  `,
  styles: `
    /* Étapes numérotées par une pastille à icône, reliées par un trait vertical. */
    .steps { margin: 0; padding: 0; list-style: none; display: grid; gap: 18px; font-size: 13px; line-height: 1.55; }
    .steps > li { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; animation: step-in .45s var(--ease) backwards; }
    .steps > li:nth-child(2) { animation-delay: 80ms; } .steps > li:nth-child(3) { animation-delay: 160ms; }
    @keyframes step-in { from { opacity: 0; transform: translateY(8px); } }
    .steps > li:not(:last-child)::before { content: ''; position: absolute; left: 13.5px; top: 32px; bottom: -16px; width: 1px;
      background: linear-gradient(var(--accent), color-mix(in srgb, var(--accent) 10%, transparent)); opacity: .5; }
    .dot { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 14px -6px var(--accent); }
    .body { min-width: 0; padding-top: 3px; }
    .body wl-code { margin-top: 8px; }
    .urls { display: grid; margin-top: 8px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); overflow: hidden; }
    .url { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 5px 6px 5px 10px; font-size: 12px;
      border-bottom: 1px solid var(--border-soft); transition: background-color .15s; animation: url-in .35s var(--ease) backwards;
      animation-delay: calc(var(--i) * 25ms + 200ms); }
    .url:last-child { border-bottom: 0; }
    .url:hover { background-color: var(--row-hover); }
    @keyframes url-in { from { opacity: 0; transform: translateX(-4px); } }
    .label { display: inline-flex; align-items: center; gap: 7px; color: var(--text-2); white-space: nowrap; }
    .label wl-nav-icon { color: var(--accent); transition: transform .35s var(--spring); }
    .url:hover .label wl-nav-icon { transform: scale(1.15) rotate(-8deg); }
    .url code { color: var(--text-1); }
    p { margin: 8px 0 0; }
    @media (max-width: 700px) { .url { grid-template-columns: minmax(0, 1fr) auto; } .url .label { grid-column: 1 / -1; } }
  `,
})
export class GrafanaGuide {
  readonly endpoint = input(location.origin);
  readonly apiKey = input('wlr_…');

  protected readonly provisioning = computed(() => `# grafana/provisioning/datasources/wolflog.yaml
apiVersion: 1
datasources:
  - name: Wolflog
    uid: wolflog
    type: yesoreyeram-infinity-datasource
    jsonData:
      auth_method: apiKey
      apiKeyKey: x-wolflog-key
      apiKeyType: header
      allowedHosts: ["${this.endpoint()}"]
    secureJsonData:
      apiKeyValue: ${this.apiKey()}`);

  protected readonly urls = computed(() => {
    const base = `${this.endpoint()}/api/grafana`;
    const range = 'from=${__from}&to=${__to}';
    return [
      { label: 'Requêtes HTTP', icon: 'requests', url: `${base}/http?stat=rate,errors,p95&${range}` },
      { label: 'Par service', icon: 'layers', url: `${base}/http?stat=p95&groupBy=service&${range}` },
      { label: 'Requête libre', icon: 'filter', url: `${base}/query?source=logs&filter=level:error&groupBy=service&${range}` },
      { label: 'Métrique', icon: 'metrics', url: `${base}/metrics?name=process.runtime.dotnet.gc.heap.size&${range}` },
      { label: 'Logs', icon: 'logs', url: `${base}/logs?filter=level:error&limit=100&${range}` },
      { label: 'Erreurs', icon: 'errors', url: `${base}/errors?${range}` },
      { label: 'Audience', icon: 'audience', url: `${base}/audience?service=mon-site&${range}` },
      { label: 'Pages vues', icon: 'page', url: `${base}/audience/breakdown?dimension=page&service=mon-site&${range}` },
      { label: 'Alertes en cours', icon: 'alerts', url: `${base}/alerts` },
    ];
  });
}
