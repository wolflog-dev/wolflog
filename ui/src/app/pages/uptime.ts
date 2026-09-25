import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, Probe, ProbeInfo, ProbeResult } from '../core/api';
import { AppState, Session } from '../core/state';
import { AgoPipe, DurPipe, TimePipe } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';

@Component({
  selector: 'vg-uptime',
  imports: [FormsModule, RouterLink, AgoPipe, DurPipe, TimePipe, Chart],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Disponibilité</h1>
        <span class="muted small">sondes HTTP et TCP exécutées par Vigil</span>
        <span class="spacer"></span>
        @if (session.canEdit()) { <a class="btn primary" routerLink="/uptime/new">Nouvelle sonde</a> }
      </div>

      <div class="split" [class.with-side]="selected()">
        <section class="panel">
          @if (items().length) {
            <table class="list">
              <thead><tr><th>État</th><th>Sonde</th><th class="r">Disponibilité</th><th class="r hide-side">Réponse moy.</th><th class="bars-h">{{ state.label() }}</th><th class="hide-side">Dernier contrôle</th></tr></thead>
              <tbody>
                @for (i of items(); track i.probe.id) {
                  <tr class="click" [class.sel]="selected()?.probe?.id === i.probe.id" (click)="select(i)">
                    <td class="nowrap"><span class="status" [class]="i.status">{{ statusLabel(i.status) }}</span></td>
                    <td class="name">
                      <div class="ellipsis">{{ i.probe.name }}</div>
                      <div class="muted small mono ellipsis">{{ i.probe.target }}</div>
                    </td>
                    <td class="r mono nowrap" [class.danger]="(i.stats?.uptime ?? 100) < 99">{{ pct(i.stats?.uptime) }}</td>
                    <td class="r mono nowrap hide-side">{{ i.stats?.avgMs | dur }}</td>
                    <td class="bars">
                      @for (b of i.stats?.buckets ?? []; track $index) {
                        <span [class]="barClass(b)" [title]="barTitle(b, $index, i.stats!.buckets.length)"></span>
                      }
                    </td>
                    <td class="muted small nowrap hide-side">
                      @if (i.last; as l) { {{ l.at | ago }}@if (!l.ok) { <span class="danger"> · {{ l.error }}</span> } } @else { – }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty">
              Aucune sonde. Une sonde appelle une adresse à intervalle régulier et mesure disponibilité et temps de réponse,
              y compris l'expiration du certificat TLS.
              @if (session.canEdit()) { <div><a class="btn primary" routerLink="/uptime/new">Nouvelle sonde</a></div> }
            </div>
          }
        </section>

        @if (selected(); as i) {
          <aside class="panel side">
            <div class="panel-head">
              <span class="status" [class]="i.status">{{ statusLabel(i.status) }}</span>
              <strong class="ellipsis">{{ i.probe.name }}</strong>
              <span class="spacer"></span>
              @if (session.canEdit()) {
                <button class="btn" (click)="runSaved(i.probe)" [disabled]="testing()">Tester</button>
                <a class="btn" [routerLink]="['/uptime', i.probe.id, 'edit']">Modifier</a>
              }
              <button class="btn ghost" (click)="selected.set(null)">Fermer</button>
            </div>
            <div class="panel-body detail">
              <div class="facts small">
                <div><span>Cible</span><strong class="mono">{{ i.probe.target }}</strong></div>
                <div><span>Disponibilité</span><strong>{{ pct(i.stats?.uptime) }}</strong></div>
                <div><span>p95</span><strong>{{ i.stats?.p95Ms | dur }}</strong></div>
                @if (i.since) { <div><span>{{ i.status === 'down' ? 'En panne depuis' : 'Dans cet état depuis' }}</span><strong>{{ i.since | ago }}</strong></div> }
                @if (i.last?.certificateDays !== null && i.last?.certificateDays !== undefined) {
                  <div><span>Certificat</span><strong [class.danger]="i.last!.certificateDays! < 14">{{ i.last!.certificateDays }} j</strong></div>
                }
              </div>
              @if (recentSeries().length) {
                <vg-chart [times]="recentTimes()" [series]="recentSeries()" [height]="120" unit="ms" [legend]="false" [deployments]="false" />
              }
              <table class="list">
                <thead><tr><th>Contrôle</th><th>Résultat</th><th class="r">Durée</th></tr></thead>
                <tbody>
                  @for (r of i.recent ?? []; track r.at) {
                    <tr>
                      <td class="mono small nowrap">{{ r.at | time: true }}</td>
                      <td class="small" [class.danger]="!r.ok">{{ r.ok ? 'OK' + (r.status ? ' (' + r.status + ')' : '') : r.error }}</td>
                      <td class="r mono small">{{ r.durationMs | dur }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="3" class="muted small">Aucun contrôle depuis le démarrage de Vigil.</td></tr>
                  }
                </tbody>
              </table>
              <div class="links small">
                <a [routerLink]="['/alerts/new']" [queryParams]="{ kind: 'probe', target: i.probe.id }">Créer une alerte</a>
                <a [routerLink]="['/slos/new']" [queryParams]="{ probe: i.probe.id }">Définir un objectif de disponibilité</a>
                <a [routerLink]="['/metrics']" [queryParams]="{ name: 'vigil.probe.duration' }">Métriques</a>
              </div>
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-side { grid-template-columns: minmax(0, 1fr) minmax(420px, 40%); }
    .side { position: sticky; top: 60px; max-height: calc(100vh - 80px); overflow: auto; }
    .status { font: 600 11px var(--mono); text-transform: uppercase; white-space: nowrap; }
    .status.up { color: var(--ok); }
    .status.down { color: var(--danger); }
    .status.unknown, .status.paused { color: var(--text-3); }
    .name { max-width: 0; width: 34%; }
    .bars-h { width: 1%; }
    .bars { display: flex; gap: 1px; height: 22px; align-items: stretch; min-width: 180px; }
    .bars span { flex: 1; min-width: 2px; border-radius: 1px; background: var(--surface-3); }
    .bars span.up { background: var(--ok); opacity: .75; }
    .bars span.partial { background: var(--warn); }
    .bars span.down { background: var(--danger); }
    tr.sel td { background: var(--row-selected); }
    .split.with-side .hide-side { display: none; }
    .form { display: grid; gap: 10px; }
    .form .seg { justify-self: start; }
    .row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    details { display: grid; gap: 10px; }
    details[open] > summary { margin-bottom: 8px; }
    details > :not(summary) + :not(summary) { margin-top: 10px; }
    summary { cursor: pointer; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; font-size: 13px; color: var(--text-1); }
    .test { padding: 8px 10px; border: 1px solid var(--ok); border-radius: var(--radius); font-size: 12.5px; }
    .test.ko { border-color: var(--danger); color: var(--danger); }
    .actions { display: flex; gap: 8px; align-items: center; }
    .detail { display: grid; gap: 12px; }
    .facts { display: flex; flex-wrap: wrap; gap: 8px 20px; }
    .facts > div { display: grid; gap: 2px; }
    .facts span { color: var(--text-3); }
    .links { display: flex; gap: 14px; flex-wrap: wrap; }
    p { margin: 0; }
    @media (max-width: 1200px) {
      .split.with-side { grid-template-columns: minmax(0, 1fr); }
      .side { position: fixed; top: 0; right: 0; bottom: 0; max-height: none; width: min(560px, 100%); z-index: 60; border-radius: 0; box-shadow: -12px 0 32px rgba(0, 0, 0, .35); }
    }
  `,
})
export class UptimePage {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  protected readonly items = signal<ProbeInfo[]>([]);
  protected readonly selected = signal<ProbeInfo | null>(null);
  protected readonly testing = signal(false);

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
    this.api.probes(this.state.range(), 60).subscribe((list) => {
      this.items.set(list);
      const sel = this.selected();
      if (sel) this.selected.set(list.find((i) => i.probe.id === sel.probe.id) ?? null);
    });
  }

  protected statusLabel(s: string) {
    return ({ up: 'En ligne', down: 'En panne', unknown: 'En attente', paused: 'En pause' } as Record<string, string>)[s] ?? s;
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

  protected runSaved(p: Probe) {
    this.testing.set(true);
    this.api.testProbe(p).subscribe({ next: () => { this.testing.set(false); this.load(); }, error: () => this.testing.set(false) });
  }

}

function toMs(rel: string) {
  const n = parseFloat(rel);
  const unit = rel.slice(-1);
  return n * ({ s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 } as Record<string, number>)[unit];
}
