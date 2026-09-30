import { Component, computed, input } from '@angular/core';
import { CodeBlock } from './code-block';

/** Mise en place de Grafana : plugin Infinity, source de données Wolflog avec une clé de lecture, exemples de requêtes. */
@Component({
  selector: 'wl-grafana-guide',
  imports: [CodeBlock],
  template: `
    <ol class="steps">
      <li>
        <strong>Installer le plugin « Infinity »</strong> (gratuit, maintenu par Grafana Labs) :
        Administration › Plugins › « Infinity », ou <code>grafana cli plugins install yesoreyeram-infinity-datasource</code>.
      </li>
      <li>
        <strong>Ajouter la source de données</strong> : Connections › Data sources › Infinity, puis
        <em>Authentication</em> : API Key, clé <code>x-wolflog-key</code>, valeur ci-dessous, « In header » ;
        <em>Allowed hosts</em> : <code>{{ endpoint() }}</code>. Ou par fichier de configuration (provisioning) :
        <wl-code [code]="provisioning()" />
      </li>
      <li>
        <strong>Créer un panneau</strong> : source « Wolflog », Type JSON, Parser Backend, URL au choix :
        <table class="urls">
          @for (u of urls(); track u.label) {
            <tr><td>{{ u.label }}</td><td><code>{{ u.url }}</code></td></tr>
          }
        </table>
        <p class="muted small">Colonne <code>time</code> : choisissez le format « Time series » ; les autres URL renvoient des tableaux.
          Filtres communs : <code>service</code>, <code>env</code>. Un tableau de bord d'exemple est fourni dans
          <code>deploy/grafana/wolflog-dashboard.json</code>.</p>
      </li>
    </ol>
  `,
  styles: `
    .steps { margin: 0; padding-left: 20px; display: grid; gap: 14px; font-size: 13px; line-height: 1.55; }
    .steps wl-code { display: block; margin-top: 8px; }
    .urls { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 12px; }
    .urls td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border-soft, var(--border)); vertical-align: top; }
    .urls td:first-child { color: var(--text-2); white-space: nowrap; }
    .urls code { word-break: break-all; }
    p { margin: 8px 0 0; }
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
      { label: 'Requêtes HTTP', url: `${base}/http?stat=rate,errors,p95&${range}` },
      { label: 'Par service', url: `${base}/http?stat=p95&groupBy=service&${range}` },
      { label: 'Requête libre', url: `${base}/query?source=logs&filter=level:error&groupBy=service&${range}` },
      { label: 'Métrique', url: `${base}/metrics?name=process.runtime.dotnet.gc.heap.size&${range}` },
      { label: 'Logs', url: `${base}/logs?filter=level:error&limit=100&${range}` },
      { label: 'Erreurs', url: `${base}/errors?${range}` },
      { label: 'Audience', url: `${base}/audience?service=mon-site&${range}` },
      { label: 'Pages vues', url: `${base}/audience/breakdown?dimension=page&service=mon-site&${range}` },
      { label: 'Alertes en cours', url: `${base}/alerts` },
    ];
  });
}
