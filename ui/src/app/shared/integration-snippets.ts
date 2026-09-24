import { Component, computed, input } from '@angular/core';
import { CodeBlock } from './widgets';

/** Code prêt à coller pour brancher une application (serveur .NET / OTLP) ou un site web (RUM). */
@Component({
  selector: 'vg-integration-snippets',
  imports: [CodeBlock],
  template: `
    @if (kind() === 'browser') {
      <div class="steps">
        <div>
          <h3>Dans chaque page du site (avant &lt;/head&gt;)</h3>
          <vg-code [code]="rumTag()" />
        </div>
        <p class="muted small">Erreurs JavaScript, chargement des pages, appels fetch/XHR et Web Vitals (LCP, INP, CLS).
          Pour relier un appel à la trace du serveur, les en-têtes <code>traceparent</code> sont ajoutés vers les domaines listés dans
          <code>data-trace-origins</code>.</p>
      </div>
    } @else {
      <div class="steps">
        <div><h3>Paquets</h3><vg-code [code]="packages" /></div>
        <div><h3>appsettings.json</h3><vg-code [code]="appsettings()" /></div>
        <div><h3>Program.cs</h3><vg-code [code]="programCs" /></div>
        <div><h3>Avec Serilog</h3><vg-code [code]="serilog" /></div>
        <p class="muted small">
          Autres langages : n'importe quel SDK OpenTelemetry. OTLP/HTTP sur <code>{{ endpoint() }}/v1/logs</code>,
          <code>/v1/traces</code>, <code>/v1/metrics</code> ; OTLP/gRPC sur le port 4317. Clé dans l'en-tête <code>x-vigil-key</code>.
          Marquer un déploiement depuis la CI : <code>curl -X POST {{ endpoint() }}/v1/deployments -H "x-vigil-key: …"
          -H "content-type: application/json" -d '{{ deployJson }}'</code>
        </p>
      </div>
    }
  `,
  styles: `
    .steps { display: grid; gap: 14px; }
    .steps h3 { margin-bottom: 6px; }
    p { margin: 0; }
  `,
})
export class IntegrationSnippets {
  readonly endpoint = input.required<string>();
  readonly apiKey = input<string | null>(null);
  readonly kind = input<'server' | 'browser'>('server');
  readonly service = input<string>('');

  protected readonly packages = 'dotnet add package Vigil.Client\ndotnet add package Vigil.Client.Serilog   # uniquement avec Serilog';
  protected readonly programCs = 'var builder = WebApplication.CreateBuilder(args);\nbuilder.AddVigil();';
  protected readonly serilog =
    'builder.Services.AddSerilog((services, log) => log\n    .ReadFrom.Configuration(builder.Configuration)\n    .WriteTo.Console()\n    .WriteTo.Vigil(services));';
  protected readonly deployJson = '{"service":"api","env":"prod","version":"1.4.2"}';

  protected readonly appsettings = computed(() => {
    const lines = [`  "Endpoint": "${this.endpoint()}"`, `  "ApiKey": "${this.apiKey() ?? '<clé API>'}"`];
    if (this.service()) lines.unshift(`  "ServiceName": "${this.service()}"`);
    return `"Vigil": {\n${lines.join(',\n')}\n}`;
  });

  protected readonly rumTag = computed(
    () =>
      `<script src="${this.endpoint()}/vigil-rum.js" defer\n` +
      `        data-key="${this.apiKey() ?? '<clé navigateur>'}"\n` +
      `        data-service="${this.service() || 'mon-site'}"\n` +
      `        data-env="prod"\n` +
      `        data-trace-origins="https://api.mondomaine.fr"></script>`,
  );
}
