import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ApiKeyInfo } from '../core/models';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';
import { exactDate } from '../core/format';

/** Types de clé : libellé, icône et teinte. */
const KINDS: Record<ApiKeyInfo['kind'], { label: string; icon: string; tone: string; hint: string }> = {
  server: { label: 'Serveur', icon: 'server', tone: 'var(--accent)', hint: 'Envoie logs, traces, métriques et crashs ; reste secrète sur le serveur' },
  browser: { label: 'Navigateur', icon: 'globe', tone: 'var(--accent-3)', hint: 'Suivi côté navigateur, limité aux sites autorisés' },
  read: { label: 'Lecture', icon: 'eye', tone: 'var(--ok)', hint: 'Lecture seule (Grafana, scripts) ; n’envoie rien' },
};

/** Clés d'ingestion : une par application, révocable, avec sa dernière utilisation. */
@Component({
  selector: 'wl-admin-keys',
  imports: [RouterLink, AgoPipe, NavIcon, Skeleton],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Clés API</h1>
        <span class="muted small">une clé par application : révocable sans toucher aux autres</span>
        <span class="spacer"></span>
        <a class="btn primary" routerLink="/admin/keys/new"><wl-nav-icon name="plus" />Connecter une application</a>
      </div>

      @if (loaded() && keys().length) {
        <div class="tally">
          @for (t of tally(); track t.label; let i = $index) {
            <span class="count" [style.--tone]="t.tone" [style.--i]="i"><wl-nav-icon [name]="t.icon" [size]="13" /><b>{{ t.count }}</b>{{ t.label }}</span>
          }
        </div>
      }

      <section class="panel">
        @if (!loaded()) {
          <wl-skeleton [rows]="4" />
        } @else if (keys().length || configKeys()) {
          <table class="list">
            <thead><tr><th>Application</th><th>Type</th><th>Clé</th><th class="hide-sm">Créée</th><th class="hide-sm">Dernière utilisation</th><th></th></tr></thead>
            <tbody>
              @for (k of keys(); track k.id) {
                <tr [class.off]="k.revokedAt">
                  <td class="app">
                    <div class="app-name">
                      <span class="app-icon" [style.--tone]="kinds[k.kind].tone"><wl-nav-icon [name]="kinds[k.kind].icon" [size]="14" /></span>
                      <span class="ellipsis" [title]="k.name">{{ k.name }}</span>
                    </div>
                    @if (k.allowedOrigins.length) {
                      <div class="origins muted small ellipsis" [title]="originsTitle(k)"><wl-nav-icon name="lock" [size]="11" />{{ k.allowedOrigins.join(', ') }}</div>
                    }
                  </td>
                  <td><span class="pill" [style.--tone]="kinds[k.kind].tone" [title]="kinds[k.kind].hint">{{ kinds[k.kind].label }}</span></td>
                  <td><code class="prefix">{{ k.prefix }}…</code></td>
                  <td class="small muted nowrap hide-sm" [title]="exact(k.createdAt)">{{ k.createdAt | ago }}{{ k.createdBy ? ' par ' + k.createdBy : '' }}</td>
                  <td class="small nowrap hide-sm">
                    @if (k.revokedAt) {
                      <span class="pill" style="--tone: var(--danger)" [title]="'Révoquée le ' + exact(k.revokedAt)"><wl-nav-icon name="close" [size]="11" />révoquée {{ k.revokedAt | ago }}</span>
                    } @else if (k.lastUsedAt) {
                      <span class="used" [class.recent]="recent(k.lastUsedAt)" [title]="exact(k.lastUsedAt)">{{ k.lastUsedAt | ago }}</span>
                    } @else {
                      <span class="used never" title="Aucun envoi reçu avec cette clé">jamais</span>
                    }
                  </td>
                  <td class="acts nowrap">
                    @if (!k.revokedAt) {
                      @if (confirm() === k.id) {
                        <span class="confirm" animate.enter="confirm-in">
                          <span class="small">Les envois avec cette clé seront refusés.</span>
                          <button class="btn danger-btn" (click)="revoke(k)"><wl-nav-icon name="close" [size]="13" />Révoquer</button>
                          <button class="btn ghost" (click)="confirm.set(null)">Annuler</button>
                        </span>
                      } @else {
                        <button class="btn ghost revoke" (click)="confirm.set(k.id)" [title]="'Révoquer la clé de ' + k.name"><wl-nav-icon name="close" [size]="13" />Révoquer</button>
                      }
                    }
                  </td>
                </tr>
              }
              @if (configKeys()) {
                <tr class="off config">
                  <td><div class="app-name"><span class="app-icon" style="--tone: var(--warn)"><wl-nav-icon name="file" [size]="14" /></span>
                    Clé{{ configKeys() > 1 ? 's' : '' }} de configuration ({{ configKeys() }})</div></td>
                  <td><span class="pill" style="--tone: var(--accent)">Serveur</span></td>
                  <td colspan="4" class="small"><wl-nav-icon class="warn-icon" name="warning" [size]="13" />
                    Définie{{ configKeys() > 1 ? 's' : '' }} dans <code>wolflog.json</code> ou générée{{ configKeys() > 1 ? 's' : '' }}
                    au premier démarrage (<code>wolflog credentials</code>). Remplacez-la par des clés par application puis retirez-la de la configuration.</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty">
            <strong>Aucune clé</strong>
            <span>« Connecter une application » crée une clé et donne le code à coller.</span>
            <a class="btn primary" routerLink="/admin/keys/new"><wl-nav-icon name="plus" />Connecter une application</a>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .tally { display: flex; flex-wrap: wrap; gap: 8px; }
    .count { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px 0 9px; border-radius: 999px; font-size: 12px;
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); animation: pop .45s var(--spring) backwards;
      animation-delay: calc(var(--i) * 50ms); }
    .count wl-nav-icon { color: var(--tone); }
    .count b { color: var(--text-1); font-variant-numeric: tabular-nums; }
    @keyframes pop { from { opacity: 0; transform: scale(.8); } }

    .app { max-width: 0; width: 34%; }
    .app-name { display: flex; align-items: center; gap: 9px; min-width: 0; font-weight: 550; }
    .app-icon { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 15%, transparent); transition: transform .4s var(--spring); }
    tr:hover .app-icon { transform: scale(1.1) rotate(-6deg); }
    .origins { display: flex; align-items: center; gap: 5px; margin: 2px 0 0 37px; }
    .origins wl-nav-icon { flex: none; }
    .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; font: 600 11.5px var(--sans);
      white-space: nowrap; color: var(--tone); background: color-mix(in srgb, var(--tone) 13%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 26%, transparent); }
    .prefix { padding: 2px 8px; border-radius: 7px; font-size: 11.5px; color: var(--text-2); background: var(--code-bg); border: 1px solid var(--border-soft); }
    .used { display: inline-flex; align-items: center; gap: 7px; color: var(--text-2); }
    /* Utilisée dans les dernières 24 h : un anneau qui pulse. */
    .used.never { color: var(--text-3); }
    tr.off td { color: var(--text-3); }
    tr.off .prefix { text-decoration: line-through; opacity: .6; }
    tr.off .app-icon { opacity: .5; }
    tr.config td { vertical-align: top; }
    .warn-icon { display: inline-flex; vertical-align: -2px; margin-right: 4px; color: var(--warn); }

    .acts { text-align: right; width: 1%; }
    .acts .btn { height: 28px; font-size: 12px; }
    .revoke { opacity: 0; transform: translateX(6px); transition: opacity .2s, transform .3s var(--spring), color .2s; }
    tr:hover .revoke, .revoke:focus-visible { opacity: 1; transform: none; }
    @media (hover: none) { .revoke { opacity: 1; transform: none; } }
    .revoke:hover { color: var(--danger); }
    .confirm { display: inline-flex; align-items: center; gap: 6px; }
    .danger-btn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); }
    .danger-btn:hover { border-color: var(--danger); background-color: color-mix(in srgb, var(--danger) 18%, transparent); }
    .confirm-in { animation: confirm-in .35s var(--spring); }
    @keyframes confirm-in { from { opacity: 0; transform: translateX(10px); } }

    .empty { display: grid; justify-items: center; gap: 6px; }
    .empty strong { color: var(--text-1); font-size: 14px; }
    .empty .btn { margin-top: 8px; }
    p { margin: 0; }
  `,
})
export class AdminKeysPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly keys = signal<ApiKeyInfo[]>([]);
  protected readonly configKeys = signal(0);
  protected readonly confirm = signal<string | null>(null);
  /** Première réponse reçue (avant : squelette). */
  protected readonly loaded = signal(false);
  protected readonly kinds = KINDS;
  protected readonly exact = exactDate;

  /** Compteurs d'en-tête : clés actives par type, puis révoquées. */
  protected readonly tally = computed(() => {
    const active = this.keys().filter((k) => !k.revokedAt);
    const names: Record<ApiKeyInfo['kind'], string> = { server: 'serveur', browser: 'navigateur', read: 'de lecture' };
    const list = (Object.keys(KINDS) as ApiKeyInfo['kind'][])
      .map((kind) => {
        const count = active.filter((k) => k.kind === kind).length;
        return { label: `${count > 1 ? 'clés' : 'clé'} ${names[kind]}`, icon: KINDS[kind].icon, tone: KINDS[kind].tone, count };
      })
      .filter((t) => t.count);
    const revoked = this.keys().length - active.length;
    if (revoked) list.push({ label: revoked > 1 ? 'révoquées' : 'révoquée', icon: 'close', tone: 'var(--danger)', count: revoked });
    return list;
  });

  constructor() {
    this.load();
  }

  private load() {
    this.api.apiKeys().subscribe({
      next: (r) => {
        this.keys.set(r.keys);
        this.configKeys.set(r.configKeys);
        this.loaded.set(true);
      },
      error: (e) => {
        this.loaded.set(true);
        this.toasts.error(e?.error?.error ?? 'Impossible de charger les clés.');
      },
    });
  }

  /** Utilisée dans les dernières 24 h. */
  protected recent(iso: string) {
    return Date.now() - new Date(iso).getTime() < 86_400_000;
  }

  protected originsTitle(k: ApiKeyInfo) {
    return 'Sites autorisés :\n' + k.allowedOrigins.join('\n');
  }

  protected revoke(k: ApiKeyInfo) {
    this.confirm.set(null);
    this.api.revokeApiKey(k.id).subscribe({
      next: () => {
        this.toasts.ok(`Clé de « ${k.name} » révoquée`, 'keys');
        this.load();
      },
      error: (e) => this.toasts.error(e?.error?.error ?? 'Révocation impossible.'),
    });
  }
}
