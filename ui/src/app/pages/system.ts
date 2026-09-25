import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, HealthReport, SystemStats } from '../core/api';
import { AgoPipe, BytesPipe, NumPipe } from '../core/format';

const NAMES: Record<string, string> = { logs: 'Logs', spans: 'Spans', metrics: 'Points de métriques' };

@Component({
  selector: 'wl-system',
  imports: [NumPipe, BytesPipe, AgoPipe, RouterLink],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Système</h1>
        @if (health(); as h) { <span class="state" [class]="h.status">{{ label(h.status) }}</span> }
        <span class="spacer"></span>
        <a class="btn" routerLink="/admin/keys/new">Connecter une application</a>
        <a class="btn" routerLink="/alerts/new" [queryParams]="{ kind: 'health' }">Alerter en cas de problème</a>
      </div>

      @if (health(); as h) {
        <section class="panel">
          <div class="panel-head"><h2>Santé de Wolflog</h2><span class="muted small">contrôlée à chaque ouverture de cette page et par les alertes « Santé de Wolflog »</span></div>
          <table class="list">
            <tbody>
              @for (c of h.checks; track c.id) {
                <tr>
                  <td class="nowrap state-cell"><span class="state" [class]="c.status">{{ label(c.status) }}</span></td>
                  <td class="nowrap">{{ c.name }}</td>
                  <td class="muted">{{ c.message }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }

      @if (stats(); as s) {
        <section class="panel">
          <div class="panel-head">
            <h2>Stockage</h2>
            <span class="muted small mono">{{ s.dataDirectory }}</span>
            <span class="spacer"></span>
            <button class="btn" (click)="flush()" [disabled]="busy()" title="Écrit tout de suite les données en mémoire (sinon toutes les minutes)">Écrire sur disque</button>
            <button class="btn" (click)="compact()" [disabled]="busy()" title="Regroupe les petits fichiers (fait automatiquement chaque heure)">Compacter</button>
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

      <section class="panel">
        <div class="panel-head"><h2>Sauvegarde</h2></div>
        <div class="panel-body backup">
          <div>
            <h3>Télécharger</h3>
            <div class="row">
              <a class="btn" [href]="api.backupUrl(false)" download (click)="later()">Configuration</a>
              <a class="btn" [href]="api.backupUrl(true)" download (click)="later()">Configuration et données</a>
            </div>
            <p class="muted small">Configuration : comptes, clés API, tableaux de bord, alertes, sondes, objectifs, recherches (quelques Ko).
              Données : tous les logs, traces et métriques conservés ({{ (stats()?.diskBytes ?? 0) | bytes }}).
              Automatisable sur le serveur : <code>wolflog backup /sauvegardes/wolflog.zip</code>.</p>
          </div>
          <div>
            <h3>Restaurer la configuration</h3>
            <div class="row">
              <label class="btn file">Choisir une sauvegarde…<input type="file" accept=".zip" (change)="restore($event)" /></label>
              @if (restoreMessage(); as m) { <span class="small" [class.ok]="!m.error" [class.danger]="m.error">{{ m.text }}</span> }
            </div>
            <p class="muted small">Remplace la configuration actuelle par celle de la sauvegarde, sans redémarrage.
              Pour restaurer aussi les données : arrêter Wolflog puis <code>wolflog restore fichier.zip</code> sur le serveur.</p>
          </div>
        </div>
      </section>
    </div>
  `,
  styles: `
    .state { font: 600 11px var(--mono); text-transform: uppercase; white-space: nowrap; }
    .state.ok { color: var(--ok); }
    .state.warning { color: var(--warn); }
    .state.critical { color: var(--danger); }
    .state-cell { width: 1%; }
    .facts { display: flex; flex-wrap: wrap; gap: 20px; padding: 10px 12px; border-top: 1px solid var(--border); color: var(--text-3); }
    .backup { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .backup h3 { margin-bottom: 8px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .file input { display: none; }
    p { margin: 8px 0 0; }
    @media (max-width: 900px) { .backup { grid-template-columns: 1fr; } }
  `,
})
export class SystemPage {
  protected readonly api = inject(Api);
  protected readonly stats = signal<SystemStats | null>(null);
  protected readonly health = signal<HealthReport | null>(null);
  protected readonly busy = signal(false);
  protected readonly restoreMessage = signal<{ text: string; error: boolean } | null>(null);

  constructor() {
    this.load();
  }

  private load() {
    this.api.system().subscribe((s) => this.stats.set(s));
    this.api.wolflogHealth().subscribe((h) => this.health.set(h));
  }

  protected label(s: string) {
    return ({ ok: 'OK', warning: 'Attention', critical: 'Problème' } as Record<string, string>)[s] ?? s;
  }

  name(n: string) { return NAMES[n] ?? n; }

  /** Après un téléchargement, la date de dernière sauvegarde change dans la santé. */
  protected later() {
    setTimeout(() => this.load(), 3000);
  }

  flush() {
    this.busy.set(true);
    this.api.flush().subscribe(() => { this.busy.set(false); this.load(); });
  }

  compact() {
    this.busy.set(true);
    this.api.compact().subscribe(() => { this.busy.set(false); this.load(); });
  }

  protected restore(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.restoreMessage.set({ text: 'Restauration…', error: false });
    this.api.restore(file).subscribe({
      next: (r) => this.restoreMessage.set({ text: `${r.configFiles} fichier(s) de configuration restauré(s).`, error: false }),
      error: (err) => this.restoreMessage.set({ text: err?.error?.error ?? 'Restauration impossible.', error: true }),
    });
  }
}
