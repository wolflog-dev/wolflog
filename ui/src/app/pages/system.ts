import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { HealthReport, SystemStats } from '../core/models';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { BytesPipe } from '../core/pipes/bytes-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';
import { exactDate } from '../core/format';

const NAMES: Record<string, string> = { logs: 'Logs', spans: 'Spans', metrics: 'Points de métriques', analytics: 'Audience web' };
const STORE_ICONS: Record<string, string> = { logs: 'logs', spans: 'traces', metrics: 'metrics', analytics: 'audience' };
const STATUS_ICONS: Record<string, string> = { ok: 'ok', warning: 'warning', critical: 'crash' };

/** État du serveur : santé, stockage par signal (part du disque), sauvegarde et restauration de la configuration. */
@Component({
  selector: 'wl-system',
  imports: [NumPipe, BytesPipe, AgoPipe, RouterLink, CountUp, NavIcon, Skeleton],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Système</h1>
        @if (health(); as h) {
          <span class="status" [class]="h.status" [title]="'Contrôlé ' + (h.at | ago)"><wl-nav-icon [name]="statusIcon(h.status)" [size]="14" />{{ label(h.status) }}</span>
        }
        <span class="spacer"></span>
        <a class="btn" routerLink="/admin/keys/new"><wl-nav-icon name="plus" [size]="14" />Connecter une application</a>
        <a class="btn" routerLink="/alerts/new" [queryParams]="{ kind: 'health' }"><wl-nav-icon name="bell" [size]="14" />Alerter en cas de problème</a>
      </div>

      @if (health(); as h) {
        <section class="panel">
          <div class="panel-head">
            <h2>Santé de Wolflog</h2>
            <span class="muted small">contrôlée à chaque ouverture de cette page et par les alertes « Santé de Wolflog »</span>
            <span class="spacer"></span>
            <span class="tally small">
              @for (t of tally(); track t.status) { <span class="mini" [class]="t.status"><wl-nav-icon [name]="statusIcon(t.status)" [size]="12" />{{ t.count }} {{ t.label }}</span> }
            </span>
          </div>
          <table class="list">
            <tbody>
              @for (c of h.checks; track c.id) {
                <tr [class]="'check-' + c.status">
                  <td class="nowrap state-cell"><span class="state" [class]="c.status"><wl-nav-icon [name]="statusIcon(c.status)" [size]="14" />{{ label(c.status) }}</span></td>
                  <td class="nowrap check-name">{{ c.name }}</td>
                  <td class="muted">{{ c.message }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      } @else {
        <section class="panel"><div class="panel-head"><h2>Santé de Wolflog</h2></div><wl-skeleton [rows]="4" /></section>
      }

      @if (stats(); as s) {
        <section class="panel">
          <div class="panel-head">
            <h2>Stockage</h2>
            <span class="dir mono small ellipsis" [title]="s.dataDirectory"><wl-nav-icon name="database" [size]="12" />{{ s.dataDirectory }}</span>
            <span class="spacer"></span>
            <button class="btn" (click)="flush()" [disabled]="busy()" title="Écrit tout de suite les données en mémoire (sinon toutes les minutes)">
              <wl-nav-icon [name]="action() === 'flush' ? 'refresh' : 'download'" [class.spin]="action() === 'flush'" [size]="14" />Écrire sur disque
            </button>
            <button class="btn" (click)="compact()" [disabled]="busy()" title="Regroupe les petits fichiers (fait automatiquement chaque heure)">
              <wl-nav-icon [name]="action() === 'compact' ? 'refresh' : 'layers'" [class.spin]="action() === 'compact'" [size]="14" />Compacter
            </button>
          </div>
          <div class="tiles">
            <div class="tile" style="--i: 0"><span><wl-nav-icon name="database" [size]="13" />Disque</span><strong [wlCountUp]="s.diskBytes | bytes"></strong></div>
            <div class="tile" style="--i: 1"><span><wl-nav-icon name="gauge" [size]="13" />Mémoire</span><strong [wlCountUp]="s.memoryBytes | bytes"></strong></div>
            <div class="tile" style="--i: 2"><span><wl-nav-icon name="play" [size]="13" />Flux en direct</span><strong [wlCountUp]="s.liveTailClients"></strong></div>
            <div class="tile" style="--i: 3" [title]="exact(s.startedAt)"><span><wl-nav-icon name="clock" [size]="13" />Démarré</span><strong class="text">{{ s.startedAt | ago }}</strong></div>
            <div class="tile" style="--i: 4"><span><wl-nav-icon name="sparkles" [size]="13" />Version</span><strong class="text mono">{{ s.version }}</strong></div>
          </div>
          <table class="list">
            <thead>
              <tr><th>Signal</th><th class="r hide-sm">Reçus depuis le démarrage</th><th class="r hide-sm">En mémoire</th><th class="r hide-sm">Segments</th><th class="r">Sur disque</th><th class="share-col">Part du disque</th><th class="hide-sm">Plus ancienne donnée</th></tr>
            </thead>
            <tbody>
              @for (st of s.stores; track st.name; let i = $index) {
                <tr>
                  <td><span class="signal"><span class="signal-icon"><wl-nav-icon [name]="storeIcon(st.name)" [size]="13" /></span>{{ name(st.name) }}</span></td>
                  <td class="r hide-sm"><span [wlCountUp]="st.ingestedRows | num"></span></td>
                  <td class="r hide-sm">{{ st.hotRows | num }}</td>
                  <td class="r hide-sm">{{ st.segments }}</td>
                  <td class="r">{{ st.diskBytes | bytes }}</td>
                  <td class="share-col">
                    <span class="share" [title]="sharePercent(st.diskBytes) + ' % du disque utilisé par Wolflog'">
                      <span class="track"><i [style.--w]="share(st.diskBytes)" [style.--i]="i"></i></span>
                      <span class="pct">{{ sharePercent(st.diskBytes) }} %</span>
                    </span>
                  </td>
                  <td class="muted hide-sm" [title]="exact(st.oldest)">{{ st.oldest | ago }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      } @else {
        <section class="panel"><div class="panel-head"><h2>Stockage</h2></div><wl-skeleton [rows]="5" /></section>
      }

      <section class="panel">
        <div class="panel-head"><h2>Sauvegarde</h2></div>
        <div class="panel-body backup">
          <div class="card">
            <h3><span class="card-icon"><wl-nav-icon name="download" [size]="15" /></span>Télécharger</h3>
            <div class="row">
              <a class="btn" [href]="api.backupUrl(false)" download (click)="later(false)"><wl-nav-icon name="file" [size]="14" />Configuration</a>
              <a class="btn" [href]="api.backupUrl(true)" download (click)="later(true)"><wl-nav-icon name="database" [size]="14" />Configuration et données</a>
            </div>
            <p class="muted small">Configuration : comptes, profils d'accès, connexion SSO, personnalisation (logo compris), clés API, tableaux de bord, alertes, sondes, objectifs, recherches (quelques Ko).
              Données : tous les logs, traces, métriques et l'audience conservés ({{ (stats()?.diskBytes ?? 0) | bytes }}).
              Automatisable sur le serveur : <code>wolflog backup /sauvegardes/wolflog.zip</code>.</p>
          </div>
          <div class="card">
            <h3><span class="card-icon"><wl-nav-icon name="refresh" [size]="15" /></span>Restaurer la configuration</h3>
            <div class="row">
              <label class="btn file" [class.busy]="restoring()">
                <wl-nav-icon [name]="restoring() ? 'refresh' : 'file'" [class.spin]="restoring()" [size]="14" />{{ restoring() ? 'Restauration…' : 'Choisir une sauvegarde…' }}
                <input type="file" accept=".zip" (change)="restore($event)" [disabled]="restoring()" />
              </label>
              @if (restoreMessage(); as m) {
                <span class="result small" [class.ok]="!m.error" [class.danger]="m.error" animate.enter="result-in">
                  <wl-nav-icon [name]="m.error ? 'warning' : restoring() ? 'clock' : 'ok'" [size]="14" />{{ m.text }}
                </span>
              }
            </div>
            <p class="muted small">Remplace la configuration actuelle par celle de la sauvegarde, sans redémarrage.
              Pour restaurer aussi les données : arrêter Wolflog puis <code>wolflog restore fichier.zip</code> sur le serveur.</p>
          </div>
        </div>
      </section>
    </div>
  `,
  styles: `
    /* Pastille d'état globale : un point qui pulse (vert si tout va bien, rouge en cas de problème). */
    .status { display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 11px 0 9px; border-radius: 999px;
      font: 650 11px var(--mono); text-transform: uppercase; letter-spacing: .04em; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 13%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 30%, transparent);
      animation: pop .5s var(--spring) .2s backwards; }
    @keyframes pop { from { opacity: 0; transform: scale(.8); } }
    .ok { --tone: var(--ok); }
    .warning { --tone: var(--warn); }
    .critical { --tone: var(--danger); }

    .tally { display: inline-flex; gap: 6px; }
    .mini { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; line-height: 20px;
      color: var(--text-2); background: var(--surface-2); }
    .state { display: inline-flex; align-items: center; gap: 6px; font: 600 12px var(--sans); white-space: nowrap; color: var(--tone); }
    .state wl-nav-icon { transition: transform .4s var(--spring); }
    tr:hover .state wl-nav-icon { transform: scale(1.15) rotate(-8deg); }
    .state-cell { width: 1%; }
    .check-name { font-weight: 550; }
    tr.check-critical td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
    tr.check-warning td:first-child { box-shadow: inset 3px 0 0 var(--warn); }

    .dir { display: inline-flex; align-items: center; gap: 6px; max-width: 40%; padding: 2px 9px; border-radius: 999px; color: var(--text-3);
      background: var(--surface-2); border: 1px solid var(--border-soft); }
    .dir wl-nav-icon { flex: none; }
    .btn wl-nav-icon.spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-bottom: 1px solid var(--border-soft); }
    .tile { display: grid; gap: 3px; padding: 12px 16px; border-right: 1px solid var(--border-soft); min-width: 0;
      animation: tile-in .45s var(--ease) backwards; animation-delay: calc(var(--i) * 50ms + 80ms); transition: background-color .2s; }
    .tile:last-child { border-right: 0; }
    .tile:hover { background-color: var(--row-hover); }
    @keyframes tile-in { from { opacity: 0; transform: translateY(6px); } }
    .tile span { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
    .tile span wl-nav-icon { color: var(--accent); }
    .tile strong { font-size: 20px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile strong.text { font-size: 15px; line-height: 30px; }

    .signal { display: inline-flex; align-items: center; gap: 9px; font-weight: 550; }
    .signal-icon { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--accent); background: var(--accent-soft);
      transition: transform .4s var(--spring); }
    tr:hover .signal-icon { transform: scale(1.1) rotate(-6deg); }
    .share-col { width: 18%; min-width: 140px; }
    .share { display: flex; align-items: center; gap: 8px; }
    .track { flex: 1; height: 6px; overflow: hidden; border-radius: 3px; background: var(--surface-3); }
    /* Barre de part du disque : remplissage par transform (scaleX), à l'affichage puis à chaque actualisation. */
    .track i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transform-origin: left; transform: scaleX(var(--w)); transition: transform .7s var(--ease);
      animation: fill .9s var(--ease) backwards; animation-delay: calc(var(--i) * 80ms + 150ms); }
    @keyframes fill { from { transform: scaleX(0); } }
    .pct { width: 38px; text-align: right; font-size: 11.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }

    .backup { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .card { padding: 14px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-soft); background: var(--surface-2);
      transition: border-color .2s; }
    .card:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
    .card h3 { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .card-icon { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .file input { display: none; }
    .file.busy { pointer-events: none; opacity: .8; }
    .result { display: inline-flex; align-items: center; gap: 6px; }
    .result-in { animation: result-in .4s var(--spring); }
    @keyframes result-in { from { opacity: 0; transform: translateX(-6px); } }
    p { margin: 10px 0 0; }
    @media (max-width: 1100px) { .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } .tile:nth-child(3) { border-right: 0; } }
    @media (max-width: 900px) { .backup { grid-template-columns: 1fr; } }
  `,
})
export class SystemPage {
  protected readonly api = inject(Api);
  private readonly state = inject(AppState);
  private readonly toasts = inject(Toasts);
  protected readonly stats = signal<SystemStats | null>(null);
  protected readonly health = signal<HealthReport | null>(null);
  protected readonly busy = signal(false);
  /** Action de maintenance en cours (icône qui tourne sur son bouton). */
  protected readonly action = signal<'flush' | 'compact' | null>(null);
  protected readonly restoring = signal(false);
  protected readonly restoreMessage = signal<{ text: string; error: boolean } | null>(null);

  /** Contrôles par état, pour l'en-tête du panneau de santé. */
  protected readonly tally = computed(() => {
    const checks = this.health()?.checks ?? [];
    return (['critical', 'warning', 'ok'] as const)
      .map((status) => ({ status, count: checks.filter((c) => c.status === status).length, label: this.label(status).toLowerCase() }))
      .filter((t) => t.count);
  });

  constructor() {
    // Bouton « Actualiser » et actualisation automatique de la barre du haut.
    effect(() => {
      this.state.tick();
      untracked(() => this.load());
    });
  }

  private load() {
    this.api.system().subscribe({ next: (s) => this.stats.set(s), error: () => this.toasts.error('Impossible de lire l’état du stockage.') });
    this.api.wolflogHealth().subscribe({ next: (h) => this.health.set(h), error: () => this.toasts.error('Impossible de lire la santé de Wolflog.') });
  }

  protected label(s: string) {
    return ({ ok: 'OK', warning: 'Attention', critical: 'Problème' } as Record<string, string>)[s] ?? s;
  }

  protected statusIcon(s: string) {
    return STATUS_ICONS[s] ?? 'info';
  }

  name(n: string) { return NAMES[n] ?? n; }

  protected storeIcon(n: string) {
    return STORE_ICONS[n] ?? 'database';
  }

  /** Part du disque occupé par Wolflog (0 à 1). */
  protected share(bytes: number) {
    const total = this.stats()?.diskBytes ?? 0;
    return total ? Math.min(1, bytes / total).toFixed(4) : '0';
  }

  protected sharePercent(bytes: number) {
    const total = this.stats()?.diskBytes ?? 0;
    return total ? Math.round((bytes / total) * 100) : 0;
  }

  /** Date complète pour les infobulles : « mercredi 1 octobre 2026 à 14:32 ». */
  protected readonly exact = exactDate;

  /** Après un téléchargement, la date de dernière sauvegarde change dans la santé. */
  protected later(data: boolean) {
    this.toasts.info(data ? 'Sauvegarde complète en préparation : le téléchargement va démarrer' : 'Téléchargement de la configuration', 'download');
    setTimeout(() => this.load(), 3000);
  }

  flush() {
    this.run('flush', () => this.api.flush(), 'Données écrites sur disque');
  }

  compact() {
    this.run('compact', () => this.api.compact(), 'Compactage terminé');
  }

  /** Lance une action de maintenance : boutons désactivés, icône qui tourne, notification à la fin. */
  private run(action: 'flush' | 'compact', call: () => ReturnType<Api['flush']>, done: string) {
    this.busy.set(true);
    this.action.set(action);
    call().subscribe({
      next: () => {
        this.busy.set(false);
        this.action.set(null);
        this.toasts.ok(done, action === 'flush' ? 'download' : 'layers');
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.action.set(null);
        this.toasts.error(e?.error?.error ?? 'Opération impossible.');
      },
    });
  }

  protected restore(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.restoring.set(true);
    this.restoreMessage.set({ text: 'Restauration…', error: false });
    this.api.restore(file).subscribe({
      next: (r) => {
        this.restoring.set(false);
        this.restoreMessage.set({ text: `${r.configFiles} fichier(s) de configuration restauré(s).`, error: false });
        this.toasts.ok('Configuration restaurée', 'refresh');
        this.load();
      },
      error: (err) => {
        this.restoring.set(false);
        this.restoreMessage.set({ text: err?.error?.error ?? 'Restauration impossible.', error: true });
        this.toasts.error(this.restoreMessage()!.text);
      },
    });
  }
}
