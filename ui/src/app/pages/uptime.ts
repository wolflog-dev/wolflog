import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, Probe, ProbeInfo, ProbeResult } from '../core/api';
import { AppState, Session } from '../core/state';
import { AgoPipe, DurPipe, TimePipe } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';

const INTERVALS = [
  { value: 30, label: '30 s' }, { value: 60, label: '1 min' }, { value: 300, label: '5 min' }, { value: 900, label: '15 min' },
];

function blankProbe(): Probe {
  return {
    id: '', name: '', enabled: true, type: 'http', target: 'https://', method: 'GET', intervalSeconds: 60, timeoutSeconds: 10,
    expectedStatus: '200-399', expectedText: null, failuresBeforeDown: 2, service: null, ignoreTlsErrors: false,
  };
}

@Component({
  selector: 'vg-uptime',
  imports: [FormsModule, RouterLink, AgoPipe, DurPipe, TimePipe, Chart],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Disponibilité</h1>
        <span class="muted small">sondes HTTP et TCP exécutées par Vigil</span>
        <span class="spacer"></span>
        @if (session.canEdit() && !form()) { <button class="btn primary" (click)="create()">Nouvelle sonde</button> }
      </div>

      <div class="split" [class.with-side]="form() || selected()">
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
              @if (session.canEdit() && !form()) { <div><button class="btn primary" (click)="create()">Nouvelle sonde</button></div> }
            </div>
          }
        </section>

        @if (form(); as f) {
          <aside class="panel side">
            <div class="panel-head"><h2>{{ f.id ? 'Modifier la sonde' : 'Nouvelle sonde' }}</h2><span class="spacer"></span><button class="btn ghost" (click)="form.set(null)">Fermer</button></div>
            <form class="panel-body form" (ngSubmit)="save()">
              <div class="seg">
                <button type="button" [class.on]="f.type === 'http'" (click)="patch({ type: 'http', target: f.target.includes('://') ? f.target : 'https://' })">HTTP(S)</button>
                <button type="button" [class.on]="f.type === 'tcp'" (click)="patch({ type: 'tcp', target: '' })">Port TCP</button>
              </div>
              <label>{{ f.type === 'tcp' ? 'Hôte et port' : 'Adresse' }}
                <input name="t" [ngModel]="f.target" (ngModelChange)="patch({ target: $event })" [placeholder]="f.type === 'tcp' ? 'db.interne:5432' : 'https://app.mondomaine.fr/health'" class="mono" />
              </label>
              <label>Nom <input name="n" [ngModel]="f.name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></label>
              <div class="row">
                <label>Fréquence
                  <select name="i" [ngModel]="f.intervalSeconds" (ngModelChange)="patch({ intervalSeconds: +$event })">
                    @for (i of intervals; track i.value) { <option [value]="i.value">toutes les {{ i.label }}</option> }
                  </select>
                </label>
                <label>En panne après
                  <select name="fb" [ngModel]="f.failuresBeforeDown" (ngModelChange)="patch({ failuresBeforeDown: +$event })">
                    <option [value]="1">1 échec</option><option [value]="2">2 échecs</option><option [value]="3">3 échecs</option><option [value]="5">5 échecs</option>
                  </select>
                </label>
                <label>Délai max (s) <input name="to" type="number" min="1" max="120" [ngModel]="f.timeoutSeconds" (ngModelChange)="patch({ timeoutSeconds: +$event })" /></label>
              </div>
              @if (f.type === 'http') {
                <details [open]="advanced()">
                  <summary class="small muted">Réponse attendue, méthode, TLS</summary>
                  <div class="row">
                    <label>Méthode
                      <select name="m" [ngModel]="f.method" (ngModelChange)="patch({ method: $event })"><option>GET</option><option>HEAD</option><option>POST</option></select>
                    </label>
                    <label>Codes acceptés <input name="es" [ngModel]="f.expectedStatus" (ngModelChange)="patch({ expectedStatus: $event })" placeholder="200-399" /></label>
                  </div>
                  <label>Texte attendu dans la réponse <input name="et" [ngModel]="f.expectedText ?? ''" (ngModelChange)="patch({ expectedText: $event || null })" placeholder='facultatif, ex. "status":"ok"' /></label>
                  <label class="check"><input type="checkbox" name="tls" [ngModel]="f.ignoreTlsErrors" (ngModelChange)="patch({ ignoreTlsErrors: $event })" /> Accepter un certificat invalide (auto-signé)</label>
                </details>
              }
              <label>Service associé
                <select name="svc" [ngModel]="f.service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                  <option value="">aucun</option>
                  @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
                </select>
              </label>
              @if (!f.id) {
                <label class="check"><input type="checkbox" name="al" [(ngModel)]="withAlert" /> M'alerter si elle tombe en panne</label>
              }

              @if (test(); as t) {
                <div class="test" [class.ko]="!t.ok">
                  @if (t.ok) { Réponse en {{ t.durationMs | dur }}{{ t.status ? ', code ' + t.status : '' }}{{ t.certificateDays !== null ? ', certificat valide encore ' + t.certificateDays + ' j' : '' }} }
                  @else { Échec : {{ t.error }} ({{ t.durationMs | dur }}) }
                </div>
              }
              @if (error()) { <p class="danger small">{{ error() }}</p> }
              <div class="actions">
                <button class="btn primary" type="submit">{{ f.id ? 'Enregistrer' : 'Créer' }}</button>
                <button class="btn" type="button" (click)="runTest()" [disabled]="testing()">{{ testing() ? 'Test…' : 'Tester maintenant' }}</button>
                <span class="spacer"></span>
                @if (f.id) { <button class="btn ghost" type="button" (click)="remove(f.id)">Supprimer</button> }
              </div>
            </form>
          </aside>
        } @else if (selected(); as i) {
          <aside class="panel side">
            <div class="panel-head">
              <span class="status" [class]="i.status">{{ statusLabel(i.status) }}</span>
              <strong class="ellipsis">{{ i.probe.name }}</strong>
              <span class="spacer"></span>
              @if (session.canEdit()) {
                <button class="btn" (click)="runSaved(i.probe)" [disabled]="testing()">Tester</button>
                <button class="btn" (click)="edit(i.probe)">Modifier</button>
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
                <a [routerLink]="['/alerts']" [queryParams]="{ edit: 'new', kind: 'probe', target: i.probe.id }">Créer une alerte</a>
                <a [routerLink]="['/slos']" [queryParams]="{ edit: 'new', probe: i.probe.id }">Définir un objectif de disponibilité</a>
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
  protected readonly form = signal<Probe | null>(null);
  protected readonly test = signal<ProbeResult | null>(null);
  protected readonly testing = signal(false);
  protected readonly error = signal('');
  protected readonly advanced = signal(false);
  protected readonly services = signal<string[]>([]);
  protected readonly intervals = INTERVALS;
  protected withAlert = true;

  protected readonly autoName = computed(() => {
    const t = this.form()?.target ?? '';
    try { return t.includes('://') ? new URL(t).host + (new URL(t).pathname !== '/' ? new URL(t).pathname : '') : t; } catch { return t; }
  });
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
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
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
    this.form.set(null);
    this.selected.set(this.selected()?.probe.id === i.probe.id ? null : i);
  }

  protected create() {
    this.selected.set(null);
    this.test.set(null);
    this.error.set('');
    this.withAlert = true;
    this.advanced.set(false);
    this.form.set(blankProbe());
  }

  protected edit(p: Probe) {
    this.test.set(null);
    this.error.set('');
    this.advanced.set(!!p.expectedText || p.method !== 'GET' || p.ignoreTlsErrors || p.expectedStatus !== '200-399');
    this.form.set({ ...p });
  }

  protected patch(change: Partial<Probe>) {
    this.form.update((f) => (f ? { ...f, ...change } : f));
  }

  protected runTest() {
    const f = this.form();
    if (!f) return;
    this.testing.set(true);
    this.error.set('');
    this.api.testProbe({ ...f, name: f.name || this.autoName() }).subscribe({
      next: (r) => { this.test.set(r); this.testing.set(false); },
      error: (e) => { this.error.set(e?.error?.error ?? 'Test impossible.'); this.testing.set(false); },
    });
  }

  protected runSaved(p: Probe) {
    this.testing.set(true);
    this.api.testProbe(p).subscribe({ next: () => { this.testing.set(false); this.load(); }, error: () => this.testing.set(false) });
  }

  protected save() {
    const f = this.form();
    if (!f) return;
    const isNew = !f.id;
    this.api.saveProbe({ ...f, name: f.name.trim() || this.autoName() }).subscribe({
      next: (saved) => {
        this.form.set(null);
        if (isNew && this.withAlert) {
          this.api.saveAlert({ name: `${saved.name} en panne`, kind: 'probe', targetId: saved.id, severity: 'critical', channels: [], enabled: true,
            comparison: 'above', threshold: 14, windowMinutes: 5, forMinutes: 0, repeatMinutes: 0, minCount: 0, notifyResolved: true }).subscribe();
        }
        // Premier contrôle immédiat pour ne pas attendre l'intervalle.
        this.api.testProbe(saved).subscribe({ next: () => this.load(), error: () => this.load() });
      },
      error: (e) => this.error.set(e?.error?.error ?? 'Enregistrement impossible.'),
    });
  }

  protected remove(id: string) {
    this.api.deleteProbe(id).subscribe(() => {
      this.form.set(null);
      this.load();
    });
  }
}

function toMs(rel: string) {
  const n = parseFloat(rel);
  const unit = rel.slice(-1);
  return n * ({ s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 } as Record<string, number>)[unit];
}
