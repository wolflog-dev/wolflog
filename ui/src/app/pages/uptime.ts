import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Probe, ProbeInfo } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { formatDuration } from '../core/format';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { DurPipe } from '../core/pipes/dur-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { Chart, ChartSeries } from '../shared/chart';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';

/** Moyenne des valeurs connues (null si aucune). */
function mean(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => v !== null && v !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

/**
 * Disponibilité : chiffres clés, liste des sondes avec l'historique en barres, et détail d'une sonde
 * (derniers contrôles, test immédiat, liens vers alertes et objectifs). Actualisée toutes les 15 secondes.
 */
@Component({
  selector: 'wl-uptime',
  imports: [RouterLink, AgoPipe, DurPipe, TimePipe, Chart, CountUp, NavIcon, Skeleton],
  host: { '(document:keydown.escape)': 'escape($event)' },
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Disponibilité</h1>
        <span class="muted small">sondes HTTP et TCP exécutées par Wolflog</span>
        <span class="spacer"></span>
        @if (items().length) {
          <span class="live" title="Actualisation automatique toutes les 15 secondes"><wl-nav-icon name="refresh" [size]="12" />toutes les 15 s</span>
        }
        @if (session.canEdit()) { <a class="btn primary" routerLink="/uptime/new"><wl-nav-icon name="plus" [size]="15" />Nouvelle sonde</a> }
      </div>

      @if (!loaded() || items().length) {
        <div class="stats panel">
          <div class="t-ok">
            <span><wl-nav-icon name="ok" [size]="13" />En ligne</span>
            @if (loaded()) { <strong [wlCountUp]="counts().up"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>@if (loaded()) { sur {{ items().length }} sonde{{ items().length > 1 ? 's' : '' }} } @else { &nbsp; }</em>
          </div>
          <div class="t-down" [class.alarm]="counts().down > 0">
            <span><wl-nav-icon name="warning" [size]="13" />En panne</span>
            @if (loaded()) { <strong [class.danger]="counts().down > 0" [wlCountUp]="counts().down"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>@if (loaded()) { {{ counts().down ? 'à traiter' : 'aucune panne' }} } @else { &nbsp; }</em>
          </div>
          <div class="t-pct">
            <span><wl-nav-icon name="percent" [size]="13" />Disponibilité moyenne</span>
            @if (loaded()) { <strong [wlCountUp]="pct(avgUptime())"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>{{ state.label() }}</em>
          </div>
          <div class="t-time">
            <span><wl-nav-icon name="timer" [size]="13" />Réponse moyenne</span>
            @if (loaded()) { <strong [wlCountUp]="avgResponse() | dur"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>toutes sondes confondues</em>
          </div>
        </div>
      }

      <div class="split" [class.with-side]="selected()">
        <section class="panel">
          @if (!loaded()) {
            <wl-skeleton [rows]="5" />
          } @else if (items().length) {
            <table class="list">
              <thead><tr><th>État</th><th>Sonde</th><th class="r">Disponibilité</th><th class="r hide-side">Réponse moy.</th><th class="bars-h">{{ state.label() }}</th><th class="hide-side">Dernier contrôle</th><th></th></tr></thead>
              <tbody>
                @for (i of items(); track i.probe.id) {
                  <tr class="click" [class.sel]="selected()?.probe?.id === i.probe.id" [class.is-down]="i.status === 'down'" (click)="select(i)">
                    <td class="nowrap"><span class="pill" [class]="i.status"><wl-nav-icon [name]="statusIcon(i.status)" [size]="12" />{{ statusLabel(i.status) }}</span></td>
                    <td class="name">
                      <div class="name-row">
                        <span class="kind" [title]="i.probe.type === 'tcp' ? 'Port TCP' : 'Adresse web'"><wl-nav-icon [name]="i.probe.type === 'tcp' ? 'server' : 'globe'" [size]="14" /></span>
                        <div class="name-text">
                          <div class="ellipsis" [title]="i.probe.name">{{ i.probe.name }}</div>
                          <div class="muted small mono ellipsis" [title]="i.probe.target">{{ i.probe.target }}</div>
                        </div>
                      </div>
                    </td>
                    <td class="r mono nowrap" [class.danger]="(i.stats?.uptime ?? 100) < 99" [class.warn]="(i.stats?.uptime ?? 100) >= 99 && (i.stats?.uptime ?? 100) < 99.9">{{ pct(i.stats?.uptime) }}</td>
                    <td class="r mono nowrap hide-side">{{ i.stats?.avgMs | dur }}</td>
                    <td class="bars">
                      @for (b of i.stats?.buckets ?? []; track $index) {
                        <span [class]="barClass(b)" [title]="barTitle(b, $index, i.stats!.buckets.length)" [style.--i]="$index"></span>
                      }
                    </td>
                    <td class="muted small nowrap hide-side">
                      @if (i.last; as l) {
                        <span class="last">
                          <span [title]="l.at | time: true">{{ l.at | ago }}</span>
                          @if (!l.ok) { <span class="danger ellipsis err" [title]="l.error ?? ''">· {{ l.error }}</span> }
                        </span>
                      } @else { – }
                    </td>
                    <td class="chev"><wl-nav-icon name="chevron-right" [size]="15" /></td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty">
              Aucune sonde. Une sonde appelle une adresse à intervalle régulier et mesure disponibilité et temps de réponse,
              y compris l'expiration du certificat TLS.
              @if (session.canEdit()) { <div class="cta"><a class="btn primary" routerLink="/uptime/new"><wl-nav-icon name="plus" [size]="15" />Nouvelle sonde</a></div> }
            </div>
          }
        </section>

        @if (selected(); as i) {
          <aside class="panel side" animate.enter="side-in">
            <div class="panel-head">
              <span class="pill" [class]="i.status"><wl-nav-icon [name]="statusIcon(i.status)" [size]="12" />{{ statusLabel(i.status) }}</span>
              <strong class="ellipsis" [title]="i.probe.name">{{ i.probe.name }}</strong>
              <span class="spacer"></span>
              @if (session.canEdit()) {
                <button class="btn" (click)="runSaved(i.probe)" [disabled]="testing()" title="Lancer un contrôle maintenant">
                  @if (testing()) { <span class="spinner"></span> } @else { <wl-nav-icon name="play" [size]="13" /> }
                  Tester
                </button>
                <a class="btn" [routerLink]="['/uptime', i.probe.id, 'edit']"><wl-nav-icon name="edit" [size]="14" />Modifier</a>
              }
              <button class="btn ghost icon" (click)="selected.set(null)" title="Fermer (Échap)" aria-label="Fermer"><wl-nav-icon name="close" [size]="16" /></button>
            </div>
            <div class="panel-body detail">
              <div class="facts small">
                <div class="fact wide"><span><wl-nav-icon [name]="i.probe.type === 'tcp' ? 'server' : 'globe'" [size]="12" />Cible</span><strong class="mono ellipsis" [title]="i.probe.target">{{ i.probe.target }}</strong></div>
                <div class="fact"><span><wl-nav-icon name="percent" [size]="12" />Disponibilité</span><strong [class.danger]="(i.stats?.uptime ?? 100) < 99" [wlCountUp]="pct(i.stats?.uptime)"></strong></div>
                <div class="fact"><span><wl-nav-icon name="timer" [size]="12" />p95</span><strong [wlCountUp]="i.stats?.p95Ms | dur"></strong></div>
                @if (i.since) {
                  <div class="fact"><span><wl-nav-icon name="clock" [size]="12" />{{ i.status === 'down' ? 'En panne depuis' : 'Dans cet état depuis' }}</span><strong [class.danger]="i.status === 'down'" [title]="i.since | time: true">{{ i.since | ago }}</strong></div>
                }
                @if (i.last?.certificateDays !== null && i.last?.certificateDays !== undefined) {
                  <div class="fact"><span><wl-nav-icon name="lock" [size]="12" />Certificat</span>
                    <strong [class.danger]="i.last!.certificateDays! < 14" [class.warn]="i.last!.certificateDays! >= 14 && i.last!.certificateDays! < 30"
                            [title]="certificateTitle(i.last!.certificateDays!)">{{ i.last!.certificateDays! < 0 ? 'expiré' : i.last!.certificateDays + ' j' }}</strong></div>
                }
              </div>
              @if (recentSeries().length) {
                <wl-chart [times]="recentTimes()" [series]="recentSeries()" [height]="120" unit="ms" [legend]="false" [deployments]="false" />
              }
              <table class="list">
                <thead><tr><th>Contrôle</th><th>Résultat</th><th class="r">Durée</th></tr></thead>
                <tbody>
                  @for (r of i.recent ?? []; track r.at) {
                    <tr>
                      <td class="mono small nowrap" [title]="r.at | ago">{{ r.at | time: true }}</td>
                      <td class="small res" [class.danger]="!r.ok">
                        <span class="res-in"><wl-nav-icon [name]="r.ok ? 'ok' : 'warning'" [size]="13" /><span class="ellipsis" [title]="r.ok ? '' : (r.error ?? '')">{{ r.ok ? 'OK' + (r.status ? ' (' + r.status + ')' : '') : r.error }}</span></span>
                      </td>
                      <td class="r mono small">{{ r.durationMs | dur }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="3" class="muted small">Aucun contrôle depuis le démarrage de Wolflog.</td></tr>
                  }
                </tbody>
              </table>
              <div class="links">
                <a class="link-chip" [routerLink]="['/alerts/new']" [queryParams]="{ kind: 'probe', target: i.probe.id }"><wl-nav-icon name="bell" [size]="13" />Créer une alerte</a>
                <a class="link-chip" [routerLink]="['/slos/new']" [queryParams]="{ probe: i.probe.id }"><wl-nav-icon name="slos" [size]="13" />Définir un objectif de disponibilité</a>
                <a class="link-chip" [routerLink]="['/metrics']" [queryParams]="{ name: 'wolflog.probe.duration' }"><wl-nav-icon name="metrics" [size]="13" />Métriques</a>
              </div>
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    /* Indicateur « en direct » et chiffres clés. */
    .live { display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 11.5px;
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .stats > div { display: grid; gap: 2px; align-content: start; min-width: 0; padding: 12px 16px; border-right: 1px solid var(--border-soft); }
    .stats > div:last-child { border-right: 0; }
    .stats span { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
    .stats strong { font-size: 22px; font-weight: 650; letter-spacing: -.02em; line-height: 1.25; font-variant-numeric: tabular-nums; }
    .stats em { font-style: normal; font-size: 11.5px; color: var(--text-3); }
    .t-ok wl-nav-icon { color: var(--ok); }
    .t-down wl-nav-icon { color: var(--text-3); }
    .t-down.alarm wl-nav-icon { color: var(--danger); }
    .t-pct wl-nav-icon, .t-time wl-nav-icon { color: var(--accent); }
    .sk-num { width: 56px; height: 22px; margin: 3px 0 2px; }

    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-side { grid-template-columns: minmax(0, 1fr) minmax(420px, 40%); }
    .side { position: sticky; top: 60px; max-height: calc(100vh - 80px); overflow: auto; }
    .side-in { animation: side-in .45s var(--ease) backwards; }
    @keyframes side-in { from { opacity: 0; transform: translateX(24px); } }

    /* États en pastille : icône et couleur de l'état. */
    .pill { --tone: var(--text-3); display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px 0 8px; border-radius: 999px; flex: none;
      font: 600 11.5px/1 var(--sans); white-space: nowrap; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 26%, transparent); }
    .pill.up { --tone: var(--ok); }
    .pill.down { --tone: var(--danger); }
    .pill wl-nav-icon { flex: none; }

    /* Liste : type de sonde, barres d'historique qui montent en cascade, chevron qui glisse. */
    .name { max-width: 0; width: 34%; }
    .name-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .name-text { min-width: 0; }
    .kind { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 9px; color: var(--accent);
      background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); transition: transform .4s var(--spring); }
    tr.click:hover .kind { transform: scale(1.1) rotate(-8deg); }
    .warn { color: var(--warn); }
    .bars-h { width: 1%; }
    .bars { display: flex; gap: 1px; height: 22px; align-items: stretch; min-width: 180px; }
    .bars span { flex: 1; min-width: 2px; border-radius: 1px; background: var(--surface-3); transform-origin: bottom;
      animation: bar-in .5s var(--ease) backwards; animation-delay: calc(var(--i) * 6ms); transition: transform .25s var(--spring), opacity .2s; }
    .bars span.up { background: var(--ok); opacity: .75; }
    .bars span.partial { background: var(--warn); }
    .bars span.down { background: var(--danger); }
    .bars span:hover { transform: scaleY(1.25); opacity: 1; }
    @keyframes bar-in { from { transform: scaleY(.15); opacity: 0; } }
    .last { display: inline-flex; align-items: center; gap: 4px; max-width: 240px; }
    .last .err { min-width: 0; }
    .chev { width: 1%; padding-left: 0; color: var(--text-3); }
    .chev wl-nav-icon { transition: transform .3s var(--spring), color .2s; }
    tr.click:hover .chev wl-nav-icon, tr.sel .chev wl-nav-icon { transform: translateX(4px); color: var(--accent); }
    tr.sel td { background: var(--row-selected); }
    tr.sel td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    tr.is-down:not(.sel) td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
    .split.with-side .hide-side { display: none; }
    .cta { display: flex; justify-content: center; margin-top: 16px; }

    /* Détail : faits en tuiles, résultats avec icône, liens en pastilles. */
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .btn.icon wl-nav-icon { transition: transform .35s var(--spring); }
    .btn.icon:hover wl-nav-icon { transform: rotate(90deg); }
    .detail { display: grid; gap: 12px; }
    .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
    .fact { display: grid; gap: 3px; min-width: 0; padding: 8px 11px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .fact.wide { grid-column: 1 / -1; }
    .fact span { display: inline-flex; align-items: center; gap: 5px; color: var(--text-3); }
    .fact strong { font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .fact.wide strong { font-size: 12.5px; font-weight: 500; }
    .res { max-width: 0; width: 60%; }
    .res-in { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .res-in wl-nav-icon { color: var(--ok); }
    .res.danger .res-in wl-nav-icon { color: var(--danger); }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .link-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12px;
      border: 1px solid var(--border); background: var(--surface-2); transition: transform .3s var(--spring), border-color .2s, background-color .2s; }
    .link-chip:hover { text-decoration: none; transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); background-color: var(--surface-3); }
    .link-chip wl-nav-icon { transition: transform .4s var(--spring); }
    .link-chip:hover wl-nav-icon { transform: scale(1.15) rotate(-8deg); }
    .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(1turn); } }
    p { margin: 0; }
    @media (max-width: 1200px) {
      .split.with-side { grid-template-columns: minmax(0, 1fr); }
      .side { position: fixed; top: 0; right: 0; bottom: 0; max-height: none; width: min(560px, 100%); z-index: 60; border-radius: 0; box-shadow: var(--shadow-pop); }
    }
    @media (max-width: 900px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stats > div { border-bottom: 1px solid var(--border-soft); }
    }
  `,
})
export class UptimePage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  protected readonly items = signal<ProbeInfo[]>([]);
  protected readonly selected = signal<ProbeInfo | null>(null);
  protected readonly testing = signal(false);
  /** Première liste reçue : squelette de chargement avant. */
  protected readonly loaded = signal(false);

  protected readonly counts = computed(() => {
    const c = { up: 0, down: 0 };
    for (const i of this.items()) {
      if (i.status === 'up') c.up++;
      else if (i.status === 'down') c.down++;
    }
    return c;
  });
  protected readonly avgUptime = computed(() => mean(this.items().map((i) => i.stats?.uptime)));
  protected readonly avgResponse = computed(() => mean(this.items().map((i) => i.stats?.avgMs)));

  protected readonly recentTimes = computed(() => [...(this.selected()?.recent ?? [])].reverse().map((r) => r.at));
  protected readonly recentSeries = computed<ChartSeries[]>(() => {
    const recent = [...(this.selected()?.recent ?? [])].reverse();
    return recent.length > 1 ? [{ label: 'réponse', color: '#7aa2f7', values: recent.map((r) => r.durationMs) }] : [];
  });

  constructor() {
    effect(() => {
      this.state.tick();
      this.state.range();
      untracked(() => this.load());
    });
    // Rafraîchissement propre à la page : les contrôles tournent en continu.
    const timer = setInterval(() => this.load(), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private load() {
    this.api.probes(this.state.range(), 60).subscribe({
      next: (list) => {
        this.items.set(list);
        this.loaded.set(true);
        const sel = this.selected();
        if (sel) this.selected.set(list.find((i) => i.probe.id === sel.probe.id) ?? null);
      },
      error: () => this.loaded.set(true),
    });
  }

  /** Échap ferme le détail (sauf pendant une saisie). */
  protected escape(e: Event) {
    if ((e.target as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable]')) return;
    this.selected.set(null);
  }

  protected statusIcon(s: string) {
    return ({ up: 'ok', down: 'warning', unknown: 'clock', paused: 'pause' } as Record<string, string>)[s] ?? 'clock';
  }

  protected statusLabel(s: string) {
    return ({ up: 'En ligne', down: 'En panne', unknown: 'En attente', paused: 'En pause' } as Record<string, string>)[s] ?? s;
  }

  protected certificateTitle(days: number) {
    return days < 0
      ? `Le certificat TLS a expiré il y a ${-days} jour${-days > 1 ? 's' : ''}`
      : `Le certificat TLS expire dans ${days} jour${days > 1 ? 's' : ''}`;
  }

  protected pct(v: number | null | undefined) {
    if (v === null || v === undefined) return '–';
    return (v >= 99.995 ? 100 : v).toLocaleString('fr-FR', { maximumFractionDigits: v >= 99 ? 2 : 1 }) + ' %';
  }

  protected barClass(v: number | null) {
    if (v === null || v === undefined) return '';
    return v >= 99.99 ? 'up' : v <= 0.01 ? 'down' : 'partial';
  }

  protected barTitle(v: number | null, i: number, n: number) {
    const r = this.state.range();
    const to = r.to ? new Date(r.to).getTime() : Date.now();
    const from = /^\d+[smhdw]$/.test(r.from) ? to - toMs(r.from) : new Date(r.from).getTime();
    const start = new Date(from + ((to - from) * i) / n);
    const label = start.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return v === null || v === undefined ? `${label} : pas de contrôle` : `${label} : ${this.pct(v)} de contrôles réussis`;
  }

  protected select(i: ProbeInfo) {
    this.selected.set(this.selected()?.probe.id === i.probe.id ? null : i);
  }

  /** Contrôle immédiat d'une sonde enregistrée, résultat en notification. */
  protected runSaved(p: Probe) {
    this.testing.set(true);
    this.api.testProbe(p).subscribe({
      next: (r) => {
        this.testing.set(false);
        if (r.ok) this.toasts.ok(`${p.name} répond en ${formatDuration(r.durationMs)}`, 'uptime');
        else this.toasts.error(`${p.name} ne répond pas : ${r.error ?? 'échec du contrôle'}`);
        this.load();
      },
      error: (e) => {
        this.testing.set(false);
        this.toasts.error(e?.error?.error ?? 'Test impossible.');
      },
    });
  }
}

function toMs(rel: string) {
  const n = parseFloat(rel);
  const unit = rel.slice(-1);
  return n * ({ s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 } as Record<string, number>)[unit];
}
