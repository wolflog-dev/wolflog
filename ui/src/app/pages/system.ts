import { Component, computed, inject, signal } from '@angular/core';
import { Api, Integration, SystemStats } from '../core/api';
import { AgoPipe, BytesPipe, NumPipe } from '../core/format';
import { CodeBlock } from '../shared/widgets';

const NAMES: Record<string, string> = { logs: 'Logs', spans: 'Spans', metrics: 'Points de métriques' };

@Component({
  selector: 'vg-system',
  imports: [NumPipe, BytesPipe, AgoPipe, CodeBlock],
  template: `
    <div class="page">
      <div class="page-head"><h1>Système</h1></div>

      <section class="panel">
        <div class="panel-head"><h2>Envoyer les données d'une application .NET</h2></div>
        <div class="panel-body steps">
          <div>
            <h3>Paquets</h3>
            <vg-code [code]="packages" />
          </div>
          <div>
            <h3>appsettings.json</h3>
            <vg-code [code]="appsettings()" />
          </div>
          <div>
            <h3>Program.cs</h3>
            <vg-code [code]="programCs" />
          </div>
          <div>
            <h3>Avec Serilog</h3>
            <vg-code [code]="serilog" />
          </div>
          <p class="muted small">
            Autres langages : n'importe quel SDK OpenTelemetry. OTLP/HTTP sur <code>{{ integration()?.endpoint }}/v1/logs</code>,
            <code>/v1/traces</code>, <code>/v1/metrics</code> ; OTLP/gRPC sur le port 4317. Clé dans l'en-tête <code>x-vigil-key</code>.
          </p>
        </div>
      </section>

      @if (stats(); as s) {
        <section class="panel">
          <div class="panel-head">
            <h2>Stockage</h2>
            <span class="muted small mono">{{ s.dataDirectory }}</span>
            <span class="spacer"></span>
            <button class="btn" (click)="flush()" [disabled]="busy()">Écrire sur disque</button>
            <button class="btn" (click)="compact()" [disabled]="busy()">Compacter</button>
          </div>
          <table class="list">
            <thead>
              <tr><th>Signal</th><th class="r">Reçus depuis le démarrage</th><th class="r">En mémoire</th><th class="r">Segments</th><th class="r">Sur disque</th><th>Plus ancienne donnée</th></tr>
            </thead>
            <tbody>
              @for (st of s.stores; track st.name) {
                <tr>
                  <td>{{ name(st.name) }}</td>
                  <td class="r">{{ st.ingestedRows | num }}</td>
                  <td class="r">{{ st.hotRows | num }}</td>
                  <td class="r">{{ st.segments }}</td>
                  <td class="r">{{ st.diskBytes | bytes }}</td>
                  <td class="muted">{{ st.oldest | ago }}</td>
                </tr>
              }
            </tbody>
          </table>
          <div class="facts small">
            <span>Version {{ s.version }}</span>
            <span>Démarré {{ s.startedAt | ago }}</span>
            <span>Disque {{ s.diskBytes | bytes }}</span>
            <span>Mémoire {{ s.memoryBytes | bytes }}</span>
            <span>{{ s.liveTailClients }} flux en direct</span>
          </div>
        </section>
      }
    </div>
  `,
  styles: `
    .steps { display: grid; gap: 14px; }
    .steps h3 { margin-bottom: 6px; }
    p { margin: 0; }
    .facts { display: flex; flex-wrap: wrap; gap: 20px; padding: 10px 12px; border-top: 1px solid var(--border); color: var(--text-3); }
  `,
})
export class SystemPage {
  private readonly api = inject(Api);
  protected readonly stats = signal<SystemStats | null>(null);
  protected readonly integration = signal<Integration | null>(null);
  protected readonly busy = signal(false);

  protected readonly packages = 'dotnet add package Vigil.Client\ndotnet add package Vigil.Client.Serilog   # uniquement avec Serilog';
  protected readonly programCs = 'var builder = WebApplication.CreateBuilder(args);\nbuilder.AddVigil();';
  protected readonly serilog =
    'builder.Services.AddSerilog((services, log) => log\n    .ReadFrom.Configuration(builder.Configuration)\n    .WriteTo.Console()\n    .WriteTo.Vigil(services));';
  protected readonly appsettings = computed(() => {
    const i = this.integration();
    return `"Vigil": {\n  "Endpoint": "${i?.endpoint ?? 'http://vigil:5080'}",\n  "ApiKey": "${i?.apiKey ?? ''}"\n}`;
  });

  constructor() {
    this.load();
    this.api.integration().subscribe((i) => this.integration.set(i));
  }

  private load() {
    this.api.system().subscribe((s) => this.stats.set(s));
  }

  name(n: string) { return NAMES[n] ?? n; }

  flush() {
    this.busy.set(true);
    this.api.flush().subscribe(() => { this.busy.set(false); this.load(); });
  }

  compact() {
    this.busy.set(true);
    this.api.compact().subscribe(() => { this.busy.set(false); this.load(); });
  }
}
