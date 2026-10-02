import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { SourceInfo } from '../core/models';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';
import { exactDate } from '../core/format';

/** Formats lisibles (pastille à côté du chemin). */
const FORMAT_LABELS: Record<string, string> = { auto: 'auto', plain: 'texte', json: 'JSON', iis: 'IIS', docker: 'Docker', cri: 'Kubernetes' };

/** Teinte stable dérivée du nom du service : la même que dans la liste des services de la barre du haut. */
function serviceHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Initiales d'un nom de service : « api-commandes » → « AC ». */
function serviceInitials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Liste des sources lues par Wolflog ; création et modification sur leur propre page. */
@Component({
  selector: 'wl-admin-sources',
  imports: [RouterLink, AgoPipe, NumPipe, CountUp, NavIcon, Skeleton],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Sources</h1>
        <span class="muted small">logs lus directement par Wolflog, sans bibliothèque dans l'application : fichiers, IIS, Docker, Kubernetes, syslog</span>
        <span class="spacer"></span>
        <a class="btn primary" routerLink="/admin/sources/new"><wl-nav-icon name="plus" />Ajouter une source</a>
      </div>

      @if (items().length) {
        <div class="tally">
          @for (t of tally(); track t.cls; let i = $index) {
            <span class="count" [class]="t.cls" [style.--i]="i"><b>{{ t.count }}</b>{{ t.label }}</span>
          }
        </div>
      }

      <section class="panel">
        @if (!loaded()) {
          <wl-skeleton [rows]="4" />
        } @else if (items().length) {
          <table class="list">
            <thead><tr><th>État</th><th>Source</th><th>Service</th><th class="r">Entrées</th><th>Dernière entrée</th><th></th><th></th></tr></thead>
            <tbody>
              @for (i of items(); track i.source.id) {
                <tr class="click" (click)="open(i)" [class.paused]="!i.source.enabled">
                  <td class="nowrap"><span class="state" [class]="stateClass(i)"><wl-nav-icon [name]="stateIcon(i)" [size]="12" />{{ stateLabel(i) }}</span></td>
                  <td class="main">
                    <div class="src">
                      <span class="type-icon" [class.syslog]="i.source.type === 'syslog'" [title]="i.source.type === 'syslog' ? 'Syslog' : 'Fichiers'">
                        <wl-nav-icon [name]="i.source.type === 'syslog' ? 'server' : 'file'" [size]="14" />
                      </span>
                      <div class="src-text">
                        <div class="name"><span class="ellipsis">{{ i.source.name }}</span>
                          @if (i.source.type === 'file') { <span class="fmt">{{ formatLabel(i.source.format) }}</span> }
                          @else { <span class="fmt">{{ protocolLabel(i.source.protocol) }}</span> }
                        </div>
                        <div class="muted small mono ellipsis" [title]="i.source.type === 'syslog' ? 'syslog, port ' + i.source.port : (i.source.path ?? '')">
                          {{ i.source.type === 'syslog' ? 'syslog, port ' + i.source.port : i.source.path }}</div>
                        @if (i.status.lastError && (!i.status.lastEntryAt || i.status.lastErrorAt! > i.status.lastEntryAt)) {
                          <div class="danger small issue"><wl-nav-icon name="warning" [size]="12" /><span>{{ i.status.lastError }}</span></div>
                        } @else if (i.status.detail) {
                          <div class="muted small">{{ i.status.detail }}</div>
                        }
                      </div>
                    </div>
                  </td>
                  <td>
                    <span class="service">
                      <span class="avatar" [style.--hue]="hue(i.source.service || i.source.name)" aria-hidden="true">{{ initials(i.source.service || i.source.name) }}</span>
                      <span class="ellipsis">{{ i.source.service || i.source.name }}</span>
                    </span>
                    @if (i.source.env) { <span class="env">{{ i.source.env }}</span> }
                  </td>
                  <td class="r mono"><span [wlCountUp]="i.status.entries | num"></span></td>
                  <td class="muted small nowrap" [title]="exact(i.status.lastEntryAt)">{{ i.status.lastEntryAt ? (i.status.lastEntryAt | ago) : 'aucune' }}</td>
                  <td class="acts nowrap" (click)="$event.stopPropagation()">
                    <button class="btn ghost toggle" (click)="toggle(i)" [title]="i.source.enabled ? 'Mettre en pause' : 'Reprendre'">
                      <wl-nav-icon [name]="i.source.enabled ? 'pause' : 'play'" [size]="13" />{{ i.source.enabled ? 'Mettre en pause' : 'Reprendre' }}
                    </button>
                  </td>
                  <td class="chev"><wl-nav-icon name="chevron-right" [size]="15" /></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty">
            <strong>Aucune source</strong>
            <span>Pour une application .NET, le paquet Wolflog.Client reste le plus complet (traces, métriques, crashs) ;
              les sources servent pour le reste : IIS, services Windows ou Linux existants, conteneurs, équipements réseau (syslog).</span>
            <div class="kinds">
              @for (k of examples; track k.label) { <span class="kind"><wl-nav-icon [name]="k.icon" [size]="13" />{{ k.label }}</span> }
            </div>
            <a class="btn primary" routerLink="/admin/sources/new"><wl-nav-icon name="plus" />Ajouter une source</a>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .tally { display: flex; flex-wrap: wrap; gap: 8px; }
    .count { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px 0 10px; border-radius: 999px; font-size: 12px;
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); animation: pop .45s var(--spring) backwards;
      animation-delay: calc(var(--i) * 50ms); }
    .count b { color: var(--tone, var(--text-1)); font-variant-numeric: tabular-nums; }
    @keyframes pop { from { opacity: 0; transform: scale(.8); } }

    .state { display: inline-flex; align-items: center; gap: 7px; height: 22px; padding: 0 9px 0 8px; border-radius: 999px;
      font: 650 10.5px var(--mono); text-transform: uppercase; letter-spacing: .03em; white-space: nowrap;
      color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent); }
    .ok { --tone: var(--ok); }
    .idle, .paused { --tone: var(--text-3); }
    .error { --tone: var(--danger); }
    /* Reçoit des entrées : la pastille pulse. */

    .main { max-width: 0; width: 46%; }
    .src { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
    .src-text { display: grid; min-width: 0; }
    .type-icon { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; color: var(--accent);
      background: var(--accent-soft); transition: transform .4s var(--spring); }
    .type-icon.syslog { color: var(--accent-3); background: color-mix(in srgb, var(--accent-3) 15%, transparent); }
    tr:hover .type-icon { transform: scale(1.1) rotate(-6deg); }
    .name { display: flex; align-items: center; gap: 7px; min-width: 0; font-weight: 550; }
    .fmt { flex: none; padding: 0 7px; border-radius: 999px; font: 600 10px/17px var(--mono); color: var(--text-2); background: var(--surface-3); }
    .issue { display: flex; align-items: flex-start; gap: 5px; }
    .issue wl-nav-icon { flex: none; margin-top: 2px; }
    .service { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; vertical-align: middle; }
    .avatar { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; color: #fff; font: 700 8.5px/1 var(--sans);
      background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%)); }
    .env { margin-left: 6px; padding: 0 7px; border-radius: 999px; font: 600 10px/17px var(--mono); color: var(--text-3); border: 1px solid var(--border); }
    tr.paused td { color: var(--text-3); }
    tr.paused .avatar, tr.paused .type-icon { opacity: .5; }

    .acts { text-align: right; width: 1%; }
    .toggle { height: 28px; font-size: 12px; opacity: 0; transform: translateX(6px); transition: opacity .2s, transform .3s var(--spring); }
    tr:hover .toggle, .toggle:focus-visible { opacity: 1; transform: none; }
    @media (hover: none) { .toggle { opacity: 1; transform: none; } }
    .chev { width: 1%; padding-left: 0; color: var(--text-3); }
    .chev wl-nav-icon { transition: transform .35s var(--spring), color .2s; }
    tr.click:hover .chev wl-nav-icon { transform: translateX(4px); color: var(--accent); }

    .empty { display: grid; justify-items: center; gap: 8px; }
    .empty > span { max-width: 560px; }
    .empty strong { color: var(--text-1); font-size: 14px; }
    .kinds { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 2px; }
    .kind { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px 0 8px; border-radius: 999px; font-size: 12px;
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .kind wl-nav-icon { color: var(--accent); }
    .empty .btn { margin-top: 6px; }
  `,
})
export class AdminSourcesPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly items = signal<SourceInfo[]>([]);
  /** Première réponse reçue (avant : squelette). */
  protected readonly loaded = signal(false);
  protected readonly hue = serviceHue;
  protected readonly initials = serviceInitials;
  protected readonly examples = [
    { label: 'IIS', icon: 'globe' }, { label: 'Fichiers texte ou JSON', icon: 'file' }, { label: 'Docker', icon: 'layers' },
    { label: 'Kubernetes', icon: 'server' }, { label: 'Syslog', icon: 'terminal' },
  ];

  /** Compteurs d'en-tête par état. */
  protected readonly tally = computed(() => {
    const counts = new Map<string, number>();
    for (const i of this.items()) counts.set(this.stateClass(i), (counts.get(this.stateClass(i)) ?? 0) + 1);
    const labels: [string, string, string][] = [['ok', 'reçoit', 'reçoivent'], ['idle', 'en attente', 'en attente'], ['error', 'en erreur', 'en erreur'], ['paused', 'en pause', 'en pause']];
    return labels.filter(([cls]) => counts.get(cls)).map(([cls, one, many]) => ({ cls, count: counts.get(cls)!, label: counts.get(cls)! > 1 ? many : one }));
  });

  constructor() {
    this.load();
    const timer = setInterval(() => this.load(), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private load() {
    this.api.sources().subscribe({
      next: (l) => {
        this.items.set(l);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
  }

  protected open(i: SourceInfo) {
    this.router.navigate(['/admin/sources', i.source.id]);
  }

  protected toggle(i: SourceInfo) {
    const enabled = !i.source.enabled;
    this.api.saveSource({ ...i.source, enabled }).subscribe({
      next: () => {
        this.toasts.ok(enabled ? `Source « ${i.source.name} » reprise` : `Source « ${i.source.name} » mise en pause`, enabled ? 'play' : 'pause');
        this.load();
      },
      error: (e) => this.toasts.error(e?.error?.error ?? 'Modification impossible.'),
    });
  }

  protected formatLabel(format: string) {
    return FORMAT_LABELS[format] ?? format;
  }

  protected protocolLabel(protocol: string) {
    return protocol === 'both' ? 'UDP + TCP' : protocol.toUpperCase();
  }

  /** Date complète pour l'infobulle : « mercredi 1 octobre 2026 à 14:32 ». */
  protected readonly exact = exactDate;

  protected stateLabel(i: SourceInfo) {
    if (!i.source.enabled) return 'En pause';
    if (i.status.state === 'error') return 'Erreur';
    if (i.status.lastEntryAt) return 'Reçoit';
    return 'En attente';
  }

  protected stateIcon(i: SourceInfo) {
    return ({ ok: 'ok', error: 'warning', paused: 'pause' } as Record<string, string>)[this.stateClass(i)] ?? 'clock';
  }

  protected stateClass(i: SourceInfo) {
    if (!i.source.enabled) return 'paused';
    if (i.status.state === 'error') return 'error';
    return i.status.lastEntryAt ? 'ok' : 'idle';
  }
}
