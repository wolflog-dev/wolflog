import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiKeyInfo } from '../core/api';
import { AgoPipe } from '../core/format';
import { CopyText } from '../shared/widgets';
import { IntegrationSnippets } from '../shared/integration-snippets';

/** Clés d'ingestion : une par application, révocable, avec sa dernière utilisation. */
@Component({
  selector: 'vg-admin-keys',
  imports: [FormsModule, AgoPipe, CopyText, IntegrationSnippets],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Clés API</h1>
        <span class="muted small">une clé par application : révocable sans toucher aux autres</span>
        <span class="spacer"></span>
        @if (!adding() && !created()) { <button class="btn primary" (click)="startAdd()">Connecter une application</button> }
      </div>

      @if (adding()) {
        <form class="panel add" (ngSubmit)="create()">
          <div class="seg type">
            <button type="button" [class.on]="kind === 'server'" (click)="kind = 'server'">Application serveur</button>
            <button type="button" [class.on]="kind === 'browser'" (click)="kind = 'browser'">Site web (navigateur)</button>
          </div>
          <label>Nom de l'application <input name="n" [(ngModel)]="name" required autocomplete="off" placeholder="ex. api-commandes" /></label>
          @if (kind === 'browser') {
            <label>Sites autorisés <input name="o" [(ngModel)]="origins" placeholder="https://app.mondomaine.fr, https://www.mondomaine.fr" autocomplete="off" />
              <span class="muted small">La clé est visible dans les pages : elle ne sert qu'à l'envoi depuis ces sites.</span></label>
          }
          @if (error()) { <p class="danger small">{{ error() }}</p> }
          <div class="actions">
            <button class="btn primary" type="submit" [disabled]="!name.trim()">Créer la clé</button>
            <button class="btn" type="button" (click)="adding.set(false)">Annuler</button>
          </div>
        </form>
      }

      @if (created(); as c) {
        <section class="panel created">
          <div class="panel-head">
            <h2>Clé de « {{ c.name }} »</h2>
            <span class="spacer"></span>
            <button class="btn" (click)="created.set(null)">Terminé</button>
          </div>
          <div class="panel-body">
            <div class="key"><code>{{ c.key }}</code> <vg-copy [text]="c.key" /></div>
            <p class="muted small">Copiez-la maintenant : elle ne sera plus affichée. Elle est déjà insérée dans le code ci-dessous.</p>
            <vg-integration-snippets [endpoint]="endpoint" [apiKey]="c.key" [kind]="c.kind" [service]="c.name" />
          </div>
        </section>
      }

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
    .add { display: grid; gap: 10px; padding: 12px; max-width: 560px; }
    .type { justify-self: start; }
    .add .actions { display: flex; gap: 8px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    .created { border-color: var(--ok); }
    .key { display: flex; align-items: center; gap: 6px; font-size: 14px; }
    .key code { font-size: 13.5px; padding: 4px 8px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); user-select: all; }
    .created p { margin: 6px 0 14px; }
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
  protected readonly adding = signal(false);
  protected readonly error = signal('');
  protected readonly confirm = signal<string | null>(null);
  protected readonly created = signal<{ name: string; key: string; kind: 'server' | 'browser' } | null>(null);
  protected readonly endpoint = location.origin;
  protected name = '';
  protected kind: 'server' | 'browser' = 'server';
  protected origins = '';
  protected readonly active = computed(() => this.keys().filter((k) => !k.revokedAt).length);

  constructor() {
    this.load();
  }

  private load() {
    this.api.apiKeys().subscribe((r) => {
      this.keys.set(r.keys);
      this.configKeys.set(r.configKeys);
    });
  }

  protected startAdd() {
    this.name = '';
    this.origins = '';
    this.kind = 'server';
    this.error.set('');
    this.adding.set(true);
    setTimeout(() => (document.querySelector('vg-admin-keys form input') as HTMLInputElement | null)?.focus());
  }

  protected create() {
    this.error.set('');
    const origins = this.origins.split(/[,\s]+/).map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
    this.api.createApiKey({ name: this.name.trim(), kind: this.kind, origins }).subscribe({
      next: (r) => {
        this.adding.set(false);
        this.created.set({ name: r.name, key: r.key, kind: this.kind });
        this.load();
      },
      error: (e) => this.error.set(e?.error?.error ?? 'Création impossible.'),
    });
  }

  protected revoke(k: ApiKeyInfo) {
    this.confirm.set(null);
    this.api.revokeApiKey(k.id).subscribe(() => this.load());
  }
}
