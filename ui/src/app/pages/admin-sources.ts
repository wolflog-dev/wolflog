import { Component, DestroyRef, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, SourceInfo } from '../core/api';
import { AgoPipe, NumPipe } from '../core/format';

/** Liste des sources lues par Wolflog ; création et modification sur leur propre page. */
@Component({
  selector: 'wl-admin-sources',
  imports: [RouterLink, AgoPipe, NumPipe],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Sources</h1>
        <span class="muted small">logs lus directement par Wolflog, sans bibliothèque dans l'application : fichiers, IIS, Docker, Kubernetes, syslog</span>
        <span class="spacer"></span>
        <a class="btn primary" routerLink="/admin/sources/new">Ajouter une source</a>
      </div>

      <section class="panel">
        @if (items().length) {
          <table class="list">
            <thead><tr><th>État</th><th>Source</th><th>Service</th><th class="r">Entrées</th><th>Dernière entrée</th><th></th></tr></thead>
            <tbody>
              @for (i of items(); track i.source.id) {
                <tr class="click" (click)="open(i)">
                  <td class="nowrap"><span class="state" [class]="stateClass(i)">{{ stateLabel(i) }}</span></td>
                  <td class="main">
                    <div>{{ i.source.name }}</div>
                    <div class="muted small mono ellipsis">{{ i.source.type === 'syslog' ? 'syslog, port ' + i.source.port : i.source.path }}</div>
                    @if (i.status.lastError && (!i.status.lastEntryAt || i.status.lastErrorAt! > i.status.lastEntryAt)) {
                      <div class="danger small">{{ i.status.lastError }}</div>
                    } @else if (i.status.detail) {
                      <div class="muted small">{{ i.status.detail }}</div>
                    }
                  </td>
                  <td>{{ i.source.service || i.source.name }}</td>
                  <td class="r mono">{{ i.status.entries | num }}</td>
                  <td class="muted small nowrap">{{ i.status.lastEntryAt ? (i.status.lastEntryAt | ago) : 'aucune' }}</td>
                  <td class="acts nowrap" (click)="$event.stopPropagation()">
                    <button class="btn ghost" (click)="toggle(i)">{{ i.source.enabled ? 'Mettre en pause' : 'Reprendre' }}</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty">
            Aucune source. Pour une application .NET, le paquet Wolflog.Client reste le plus complet (traces, métriques, crashs) ;
            les sources servent pour le reste : IIS, services Windows ou Linux existants, conteneurs, équipements réseau (syslog).
            <div><a class="btn primary" routerLink="/admin/sources/new">Ajouter une source</a></div>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .state { font: 600 11px var(--mono); text-transform: uppercase; white-space: nowrap; }
    .state.ok { color: var(--ok); }
    .state.idle, .state.paused { color: var(--text-3); }
    .state.error { color: var(--danger); }
    .main { max-width: 0; width: 50%; }
    .acts { text-align: right; width: 1%; }
    .acts .btn { height: 24px; font-size: 12px; }
    tr:not(:hover) .acts .btn { visibility: hidden; }
    .empty div { margin-top: 12px; }
  `,
})
export class AdminSourcesPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly items = signal<SourceInfo[]>([]);

  constructor() {
    this.load();
    const timer = setInterval(() => this.load(), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private load() {
    this.api.sources().subscribe((l) => this.items.set(l));
  }

  protected open(i: SourceInfo) {
    this.router.navigate(['/admin/sources', i.source.id]);
  }

  protected toggle(i: SourceInfo) {
    this.api.saveSource({ ...i.source, enabled: !i.source.enabled }).subscribe(() => this.load());
  }

  protected stateLabel(i: SourceInfo) {
    if (!i.source.enabled) return 'En pause';
    if (i.status.state === 'error') return 'Erreur';
    if (i.status.lastEntryAt) return 'Reçoit';
    return 'En attente';
  }

  protected stateClass(i: SourceInfo) {
    if (!i.source.enabled) return 'paused';
    if (i.status.state === 'error') return 'error';
    return i.status.lastEntryAt ? 'ok' : 'idle';
  }
}
