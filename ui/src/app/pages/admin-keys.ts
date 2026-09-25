import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ApiKeyInfo } from '../core/api';
import { AgoPipe } from '../core/format';

/** Clés d'ingestion : une par application, révocable, avec sa dernière utilisation. */
@Component({
  selector: 'vg-admin-keys',
  imports: [RouterLink, AgoPipe],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Clés API</h1>
        <span class="muted small">une clé par application : révocable sans toucher aux autres</span>
        <span class="spacer"></span>
        <a class="btn primary" routerLink="/admin/keys/new">Connecter une application</a>
      </div>

      <section class="panel">
        @if (keys().length || configKeys()) {
          <table class="list">
            <thead><tr><th>Application</th><th>Type</th><th>Clé</th><th>Créée</th><th>Dernière utilisation</th><th></th></tr></thead>
            <tbody>
              @for (k of keys(); track k.id) {
                <tr [class.off]="k.revokedAt">
                  <td>{{ k.name }}@if (k.allowedOrigins.length) { <div class="muted small ellipsis">{{ k.allowedOrigins.join(', ') }}</div> }</td>
                  <td class="small">{{ k.kind === 'browser' ? 'Navigateur' : 'Serveur' }}</td>
                  <td class="mono small">{{ k.prefix }}…</td>
                  <td class="small muted nowrap">{{ k.createdAt | ago }}{{ k.createdBy ? ' par ' + k.createdBy : '' }}</td>
                  <td class="small nowrap" [class.muted]="!k.lastUsedAt">
                    @if (k.revokedAt) { révoquée {{ k.revokedAt | ago }} } @else { {{ k.lastUsedAt ? (k.lastUsedAt | ago) : 'jamais' }} }
                  </td>
                  <td class="acts nowrap">
                    @if (!k.revokedAt) {
                      @if (confirm() === k.id) {
                        <span class="small">Les envois avec cette clé seront refusés.</span>
                        <button class="btn danger-btn" (click)="revoke(k)">Révoquer</button>
                        <button class="btn ghost" (click)="confirm.set(null)">Annuler</button>
                      } @else {
                        <button class="btn ghost" (click)="confirm.set(k.id)">Révoquer</button>
                      }
                    }
                  </td>
                </tr>
              }
              @if (configKeys()) {
                <tr class="off">
                  <td>Clé{{ configKeys() > 1 ? 's' : '' }} de configuration ({{ configKeys() }})</td>
                  <td class="small">Serveur</td>
                  <td colspan="4" class="small">Définie{{ configKeys() > 1 ? 's' : '' }} dans <code>vigil.json</code> ou générée{{ configKeys() > 1 ? 's' : '' }}
                    au premier démarrage (<code>vigil credentials</code>). Remplacez-la par des clés par application puis retirez-la de la configuration.</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty">Aucune clé. « Connecter une application » crée une clé et donne le code à coller.</div>
        }
      </section>
    </div>
  `,
  styles: `
    tr.off td { color: var(--text-3); }
    .acts { text-align: right; width: 1%; }
    .acts .btn { height: 24px; font-size: 12px; }
    tr:not(:hover) .acts .btn.ghost { visibility: hidden; }
    .danger-btn { color: var(--danger); border-color: var(--danger); }
    p { margin: 0; }
  `,
})
export class AdminKeysPage {
  private readonly api = inject(Api);
  protected readonly keys = signal<ApiKeyInfo[]>([]);
  protected readonly configKeys = signal(0);
  protected readonly confirm = signal<string | null>(null);

  constructor() {
    this.load();
  }

  private load() {
    this.api.apiKeys().subscribe((r) => {
      this.keys.set(r.keys);
      this.configKeys.set(r.configKeys);
    });
  }

  protected revoke(k: ApiKeyInfo) {
    this.confirm.set(null);
    this.api.revokeApiKey(k.id).subscribe(() => this.load());
  }
}
