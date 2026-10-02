import { Component, computed, input } from '@angular/core';
import { CodeBlock } from './code-block';
import { NavIcon } from './nav-icon';

/** Code prêt à coller pour brancher une application (serveur .NET / OTLP) ou un site web (RUM). */
@Component({
  selector: 'wl-integration-snippets',
  imports: [CodeBlock, NavIcon],
  template: `
    @if (kind() === 'browser') {
      <div class="stack">
        <ol class="rail">
          <li>
            <span class="dot">1</span>
            <div class="body"><h3><wl-nav-icon name="code" [size]="13" />Dans chaque page du site (avant &lt;/head&gt;)</h3><wl-code [code]="rumTag()" /></div>
          </li>
        </ol>
        <div class="features">
          @for (f of rumFeatures; track f.label; let i = $index) {
            <span class="feature" [style.--i]="i"><wl-nav-icon [name]="f.icon" [size]="13" />{{ f.label }}</span>
          }
        </div>
        <p class="muted small">Erreurs JavaScript, chargement des pages, appels fetch/XHR et Web Vitals (LCP, INP, CLS).
          Pour relier un appel à la trace du serveur, les en-têtes <code>traceparent</code> sont ajoutés vers les domaines listés dans
          <code>data-trace-origins</code>.</p>
      </div>
    } @else {
      <div class="stack">
        <ol class="rail">
          <li><span class="dot">1</span><div class="body"><h3><wl-nav-icon name="download" [size]="13" />Paquets</h3><wl-code [code]="packages" /></div></li>
          <li><span class="dot">2</span><div class="body"><h3><wl-nav-icon name="file" [size]="13" />appsettings.json</h3><wl-code [code]="appsettings()" /></div></li>
          <li><span class="dot">3</span><div class="body"><h3><wl-nav-icon name="code" [size]="13" />Program.cs</h3><wl-code [code]="programCs" /></div></li>
          <li class="optional"><span class="dot">+</span>
            <div class="body"><h3><wl-nav-icon name="list" [size]="13" />Avec Serilog <span class="opt">facultatif</span></h3><wl-code [code]="serilog" /></div></li>
        </ol>
        <div class="others">
          <h3><wl-nav-icon name="globe" [size]="13" />Autres langages</h3>
          <p class="muted small">
            N'importe quel SDK OpenTelemetry. OTLP/HTTP sur <code>{{ endpoint() }}/v1/logs</code>,
            <code>/v1/traces</code>, <code>/v1/metrics</code> ; OTLP/gRPC sur le port 4317. Clé dans l'en-tête <code>x-wolflog-key</code>.
          </p>
          <h3><wl-nav-icon name="pin" [size]="13" />Marquer un déploiement depuis la CI</h3>
          <wl-code [code]="deployCommand()" />
        </div>
      </div>
    }
  `,
  styles: `
    .stack { display: grid; gap: 16px; min-width: 0; }
    h3 { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
    h3 wl-nav-icon { color: var(--accent); }
    /* Étapes numérotées reliées par un trait vertical. */
    .rail { position: relative; display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
    .rail li { position: relative; display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; animation: step-in .45s var(--ease) backwards; }
    .rail li:nth-child(2) { animation-delay: 70ms; } .rail li:nth-child(3) { animation-delay: 140ms; } .rail li:nth-child(4) { animation-delay: 210ms; }
    @keyframes step-in { from { opacity: 0; transform: translateY(8px); } }
    .rail li:not(:last-child)::before { content: ''; position: absolute; left: 12.5px; top: 30px; bottom: -14px; width: 1px;
      background: linear-gradient(var(--accent), color-mix(in srgb, var(--accent) 10%, transparent)); opacity: .5; }
    .dot { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; font: 650 11.5px var(--sans); color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 14px -6px var(--accent); }
    .optional .dot { color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
    .body { min-width: 0; padding-top: 3px; }
    .opt { padding: 0 7px; border-radius: 999px; font: 600 10px/17px var(--sans); text-transform: none; letter-spacing: 0; color: var(--text-3); background: var(--surface-3); }
    .features { display: flex; flex-wrap: wrap; gap: 6px; }
    .feature { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px 0 9px; border-radius: 999px; font-size: 12px;
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft);
      animation: chip-in .4s var(--spring) backwards; animation-delay: calc(var(--i) * 50ms + 120ms); }
    .feature wl-nav-icon { color: var(--accent); }
    @keyframes chip-in { from { opacity: 0; transform: scale(.85); } }
    .others { display: grid; gap: 4px; padding: 14px 16px; border-radius: var(--radius-sm); border: 1px dashed var(--border); }
    .others p { margin-bottom: 10px; }
    p { margin: 0; }
  `,
})
export class IntegrationSnippets {
  readonly endpoint = input.required<string>();
  readonly apiKey = input<string | null>(null);
  readonly kind = input<'server' | 'browser'>('server');
  readonly service = input<string>('');

  protected readonly packages = 'dotnet add package Wolflog.Client\ndotnet add package Wolflog.Client.Serilog   # uniquement avec Serilog';
  protected readonly programCs = 'var builder = WebApplication.CreateBuilder(args);\nbuilder.AddWolflog();';
  protected readonly serilog =
    'builder.Services.AddSerilog((services, log) => log\n    .ReadFrom.Configuration(builder.Configuration)\n    .WriteTo.Console()\n    .WriteTo.Wolflog(services));';
  /** Ce que mesure le script navigateur. */
  protected readonly rumFeatures = [
    { label: 'Erreurs JavaScript', icon: 'errors' }, { label: 'Chargement des pages', icon: 'timer' }, { label: 'Appels fetch / XHR', icon: 'requests' },
    { label: 'Web Vitals', icon: 'gauge' }, { label: 'Audience', icon: 'audience' }, { label: 'Clics et défilement', icon: 'clickmaps' },
  ];

  /** Marqueur de déploiement (CI) : clé et service déjà insérés quand ils sont connus. */
  protected readonly deployCommand = computed(() => {
    const body = JSON.stringify({ service: this.service() || 'api', env: 'prod', version: '1.4.2' });
    return `curl -X POST ${this.endpoint()}/v1/deployments \\\n  -H "x-wolflog-key: ${this.apiKey() ?? '<clé API>'}" \\\n`
      + `  -H "content-type: application/json" \\\n  -d '${body}'`;
  });

  protected readonly appsettings = computed(() => {
    const lines = [`  "Endpoint": "${this.endpoint()}"`, `  "ApiKey": "${this.apiKey() ?? '<clé API>'}"`];
    if (this.service()) lines.unshift(`  "ServiceName": "${this.service()}"`);
    return `"Wolflog": {\n${lines.join(',\n')}\n}`;
  });

  protected readonly rumTag = computed(
    () =>
      `<script src="${this.endpoint()}/wolflog-rum.js" defer\n` +
      `        data-key="${this.apiKey() ?? '<clé navigateur>'}"\n` +
      `        data-service="${this.service() || 'mon-site'}"\n` +
      `        data-env="prod"\n` +
      `        data-trace-origins="https://api.mondomaine.fr"></script>`,
  );
}
