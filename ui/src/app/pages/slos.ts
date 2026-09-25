import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, Probe, Slo, SloDetail, SloStatus } from '../core/api';
import { AppState, Session } from '../core/state';
import { NumPipe } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';

function blankSlo(): Slo {
  return {
    id: '', name: '', kind: 'availability', source: 'http', service: null, route: null, probeId: null,
    targetPercent: 99.9, latencyMs: 500, windowDays: 30, description: null,
  };
}

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? '–' : v.toLocaleString('fr-FR', { maximumFractionDigits: digits });

@Component({
  selector: 'vg-slos',
  imports: [FormsModule, RouterLink, NumPipe, Chart],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Objectifs de service</h1>
        <span class="muted small">part d'évènements réussis sur une fenêtre glissante, et budget d'erreur restant</span>
        <span class="spacer"></span>
        @if (session.canEdit() && !form()) { <button class="btn primary" (click)="create()">Nouvel objectif</button> }
      </div>

      <div class="split" [class.with-side]="form() || detail()">
        <section class="panel">
          @if (items().length) {
            <table class="list">
              <thead><tr><th>État</th><th>Objectif</th><th class="r">Mesuré</th><th class="r hide-side">Cible</th><th>Budget restant</th><th class="r hide-side">Consommation (1 h)</th></tr></thead>
              <tbody>
                @for (i of items(); track i.slo.id) {
                  <tr class="click" [class.sel]="detail()?.slo?.id === i.slo.id" (click)="open(i.slo.id)">
                    <td class="nowrap"><span class="state nowrap" [class]="i.status.state">{{ stateLabel(i.status.state) }}</span></td>
                    <td class="name">
                      <div class="ellipsis">{{ i.slo.name }}</div>
                      <div class="muted small ellipsis">{{ describe(i.slo) }}</div>
                    </td>
                    <td class="r mono nowrap">{{ pct(i.status.sli, 3) }}</td>
                    <td class="r mono muted nowrap hide-side">{{ pct(i.slo.targetPercent, 3) }}</td>
                    <td class="budget">
                      <div class="bar"><span [style.width.%]="budgetWidth(i.status)" [class]="i.status.state"></span></div>
                      <span class="mono small">{{ pct(i.status.budgetRemaining, 1) }}</span>
                    </td>
                    <td class="r mono nowrap hide-side" [class.danger]="(i.status.burnRate1h ?? 0) > 14.4" title="1 = le budget serait épuisé exactement en fin de fenêtre">{{ burn(i.status.burnRate1h) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty">
              Aucun objectif. Exemple : 99,9 % des requêtes de l'API sans erreur serveur sur 30 jours,
              soit environ 43 minutes d'indisponibilité tolérées par mois.
              @if (session.canEdit() && !form()) { <div><button class="btn primary" (click)="create()">Nouvel objectif</button></div> }
            </div>
          }
        </section>

        @if (form(); as f) {
          <aside class="panel side">
            <div class="panel-head"><h2>{{ f.id ? 'Modifier l’objectif' : 'Nouvel objectif' }}</h2><span class="spacer"></span><button class="btn ghost" (click)="closeForm()">Fermer</button></div>
            <form class="panel-body form" (ngSubmit)="save()">
              <div class="sentence">
                <input name="target" type="number" class="num" step="any" min="1" max="99.999" [ngModel]="f.targetPercent" (ngModelChange)="patch({ targetPercent: +$event })" />
                <span>% des</span>
                <div class="seg">
                  <button type="button" [class.on]="f.source === 'http'" (click)="patch({ source: 'http' })">requêtes HTTP</button>
                  <button type="button" [class.on]="f.source === 'probe'" (click)="patch({ source: 'probe', kind: 'availability' })">contrôles d'une sonde</button>
                </div>
                @if (f.source === 'http') {
                  <span>de</span>
                  <select name="svc" [ngModel]="f.service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                    <option value="">choisir un service</option>
                    @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
                  </select>
                  <input name="route" class="route" [ngModel]="f.route ?? ''" (ngModelChange)="patch({ route: $event || null })" placeholder="route (facultatif)" />
                  <span>doivent être</span>
                  <div class="seg">
                    <button type="button" [class.on]="f.kind === 'availability'" (click)="patch({ kind: 'availability' })">sans erreur serveur</button>
                    <button type="button" [class.on]="f.kind === 'latency'" (click)="patch({ kind: 'latency' })">plus rapides que</button>
                  </div>
                  @if (f.kind === 'latency') {
                    <input name="lat" type="number" class="num" min="1" [ngModel]="f.latencyMs" (ngModelChange)="patch({ latencyMs: +$event })" /><span>ms</span>
                  }
                } @else {
                  <select name="probe" [ngModel]="f.probeId ?? ''" (ngModelChange)="patch({ probeId: $event || null })">
                    <option value="">choisir une sonde</option>
                    @for (p of probes(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                  </select>
                  <span>doivent réussir</span>
                }
                <span>sur</span>
                <select name="win" [ngModel]="f.windowDays" (ngModelChange)="patch({ windowDays: +$event })">
                  <option [value]="7">7 jours</option><option [value]="28">28 jours</option><option [value]="30">30 jours</option><option [value]="90">90 jours</option>
                </select>
              </div>
              <p class="muted small">Budget d'erreur : {{ allowance() }}</p>
              <label>Nom <input name="n" [ngModel]="f.name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></label>
              @if (!f.id) {
                <label class="check"><input type="checkbox" name="al" [(ngModel)]="withAlert" /> M'alerter si le budget se consomme trop vite (14,4× sur 1 h)</label>
              }
              @if (error()) { <p class="danger small">{{ error() }}</p> }
              <div class="actions">
                <button class="btn primary" type="submit">{{ f.id ? 'Enregistrer' : 'Créer' }}</button>
                <button class="btn" type="button" (click)="closeForm()">Annuler</button>
                <span class="spacer"></span>
                @if (f.id) { <button class="btn ghost" type="button" (click)="remove(f.id)">Supprimer</button> }
              </div>
            </form>
          </aside>
        } @else if (detail(); as d) {
          <aside class="panel side">
            <div class="panel-head">
              <span class="state" [class]="d.status.state">{{ stateLabel(d.status.state) }}</span>
              <strong class="ellipsis">{{ d.slo.name }}</strong>
              <span class="spacer"></span>
              @if (session.canEdit()) { <button class="btn" (click)="edit(d.slo)">Modifier</button> }
              <button class="btn ghost" (click)="close()">Fermer</button>
            </div>
            <div class="panel-body detail">
              <div class="facts small">
                <div><span>Mesuré</span><strong>{{ pct(d.status.sli, 3) }}</strong></div>
                <div><span>Cible</span><strong>{{ pct(d.slo.targetPercent, 3) }}</strong></div>
                <div><span>Budget restant</span><strong [class.danger]="(d.status.budgetRemaining ?? 100) < 0">{{ pct(d.status.budgetRemaining, 1) }}</strong></div>
                <div><span>Évènements</span><strong>{{ d.status.total | num }}</strong></div>
                <div><span>En échec</span><strong>{{ d.status.bad | num }}</strong></div>
                <div><span>Consommation 1 h / 6 h</span><strong>{{ burn(d.status.burnRate1h) }} / {{ burn(d.status.burnRate6h) }}</strong></div>
              </div>
              <h3>Budget d'erreur restant ({{ d.slo.windowDays }} jours)</h3>
              <vg-chart [times]="times()" [series]="budgetSeries()" [height]="130" unit="%" [legend]="false" />
              <h3>Réussite par intervalle</h3>
              <vg-chart [times]="times()" [series]="sliSeries()" [height]="110" unit="%" [legend]="false" />
              <div class="links small">
                <a [routerLink]="['/alerts']" [queryParams]="{ edit: 'new', kind: 'slo', target: d.slo.id }">Créer une alerte de consommation</a>
                @if (d.slo.source === 'http') {
                  <a [routerLink]="['/requests']" [queryParams]="{ service: d.slo.service, q: d.slo.route, status: d.slo.kind === 'availability' ? 'errors' : null, minMs: d.slo.kind === 'latency' ? d.slo.latencyMs : null }">Voir les requêtes en échec</a>
                } @else {
                  <a routerLink="/uptime">Voir la sonde</a>
                }
              </div>
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-side { grid-template-columns: minmax(0, 1fr) minmax(440px, 42%); }
    .side { position: sticky; top: 60px; max-height: calc(100vh - 80px); overflow: auto; }
    .state { font: 600 11px var(--mono); text-transform: uppercase; white-space: nowrap; }
    .state.ok { color: var(--ok); }
    .state.warning { color: var(--warn); }
    .state.breached { color: var(--danger); }
    .name { max-width: 0; width: 36%; }
    .budget { display: flex; align-items: center; gap: 8px; min-width: 150px; white-space: nowrap; }
    .split.with-side .hide-side { display: none; }
    .bar { flex: 1; height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--ok); }
    .bar span.warning { background: var(--warn); }
    .bar span.breached { background: var(--danger); }
    tr.sel td { background: var(--row-selected); }
    .form { display: grid; gap: 12px; }
    .sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
    .num { width: 80px; }
    .route { width: 160px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; font-size: 13px; color: var(--text-1); }
    .actions { display: flex; gap: 8px; align-items: center; }
    .detail { display: grid; gap: 10px; }
    .facts { display: flex; flex-wrap: wrap; gap: 8px 20px; }
    .facts > div { display: grid; gap: 2px; }
    .facts span { color: var(--text-3); }
    h3 { margin-top: 6px; }
    .links { display: flex; gap: 14px; flex-wrap: wrap; }
    p { margin: 0; }
    @media (max-width: 1200px) {
      .split.with-side { grid-template-columns: minmax(0, 1fr); }
      .side { position: fixed; top: 0; right: 0; bottom: 0; max-height: none; width: min(600px, 100%); z-index: 60; border-radius: 0; box-shadow: -12px 0 32px rgba(0, 0, 0, .35); }
    }
  `,
})
export class SlosPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  /** /slos/:id (liens des alertes) ou ?edit=new&probe=… (depuis une sonde). */
  readonly id = input<string>('');
  readonly editParam = input<string>('', { alias: 'edit' });
  readonly probe = input<string>('');

  protected readonly items = signal<{ slo: Slo; status: SloStatus }[]>([]);
  protected readonly detail = signal<SloDetail | null>(null);
  protected readonly form = signal<Slo | null>(null);
  protected readonly error = signal('');
  protected readonly services = signal<string[]>([]);
  protected readonly probes = signal<Probe[]>([]);
  protected withAlert = true;

  protected readonly times = computed(() => this.detail()?.history.map((h) => h.t) ?? []);
  protected readonly budgetSeries = computed<ChartSeries[]>(() => [
    { label: 'budget restant', color: '#7fb685', values: this.detail()?.history.map((h) => h.budgetRemaining) ?? [] },
  ]);
  protected readonly sliSeries = computed<ChartSeries[]>(() => [
    { label: 'réussite', color: '#7aa2f7', values: this.detail()?.history.map((h) => h.sli) ?? [] },
  ]);
  protected readonly autoName = computed(() => {
    const f = this.form();
    return f ? this.describe(f) : '';
  });
  protected readonly allowance = computed(() => {
    const f = this.form();
    if (!f) return '';
    const minutes = (f.windowDays * 24 * 60 * (100 - f.targetPercent)) / 100;
    const time = minutes >= 120 ? `${fmt(minutes / 60, 1)} h` : `${fmt(minutes, 0)} min`;
    return `${fmt(100 - f.targetPercent, 3)} % d'échecs tolérés, soit environ ${time} d'indisponibilité totale sur ${f.windowDays} jours.`;
  });

  constructor() {
    effect(() => {
      this.state.tick();
      untracked(() => this.load());
    });
    effect(() => {
      const id = this.id();
      const edit = this.editParam();
      const probe = this.probe();
      untracked(() => {
        if (id) this.open(id, false);
        if (edit === 'new') {
          this.create();
          if (probe) this.patch({ source: 'probe', probeId: probe });
        }
      });
    });
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
    this.api.probes({ from: '1h', to: '' }, 1).subscribe((p) => this.probes.set(p.map((x) => x.probe)));
  }

  private load() {
    this.api.slos().subscribe((l) => this.items.set(l));
    const d = this.detail();
    if (d) this.api.slo(d.slo.id).subscribe((x) => this.detail.set(x));
  }

  protected describe(s: Slo) {
    const probe = this.probes().find((p) => p.id === s.probeId)?.name ?? 'une sonde';
    const what = s.source === 'probe'
      ? `contrôles de ${probe} réussis`
      : `requêtes de ${s.service ?? '?'}${s.route ? ' ' + s.route : ''} ${s.kind === 'latency' ? `en moins de ${fmt(s.latencyMs, 0)} ms` : 'sans erreur'}`;
    return `${fmt(s.targetPercent, 3)} % des ${what} sur ${s.windowDays} j`;
  }

  protected stateLabel(s: string) {
    return ({ ok: 'Tenu', warning: 'À surveiller', breached: 'Non tenu' } as Record<string, string>)[s] ?? s;
  }

  protected pct(v: number | null | undefined, digits: number) {
    return v === null || v === undefined ? '–' : fmt(v, digits) + ' %';
  }

  protected burn(v: number | null | undefined) {
    return v === null || v === undefined ? '–' : fmt(v, 1) + '×';
  }

  protected budgetWidth(s: SloStatus) {
    return Math.max(0, Math.min(100, s.budgetRemaining ?? 0));
  }

  protected open(id: string, toggle = true) {
    this.form.set(null);
    if (toggle && this.detail()?.slo.id === id) return this.close();
    this.api.slo(id).subscribe((d) => this.detail.set(d));
  }

  protected close() {
    this.detail.set(null);
    if (this.id()) this.router.navigate(['/slos']);
  }

  protected create() {
    this.detail.set(null);
    this.error.set('');
    this.withAlert = true;
    // Service présélectionné : celui du filtre global, ou le seul service connu.
    const only = this.services().length === 1 ? this.services()[0] : null;
    this.form.set({ ...blankSlo(), service: this.state.service() || only });
  }

  protected edit(s: Slo) {
    this.error.set('');
    this.form.set({ ...s });
  }

  protected closeForm() {
    this.form.set(null);
    if (this.editParam()) this.router.navigate([], { queryParams: { edit: null, probe: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected patch(change: Partial<Slo>) {
    this.form.update((f) => (f ? { ...f, ...change } : f));
  }

  protected save() {
    const f = this.form();
    if (!f) return;
    const isNew = !f.id;
    this.api.saveSlo({ ...f, name: f.name.trim() || this.autoName() }).subscribe({
      next: (saved) => {
        if (isNew && this.withAlert) {
          this.api.saveAlert({ name: `${saved.name} : budget consommé trop vite`, kind: 'slo', targetId: saved.id, severity: 'critical', channels: [],
            enabled: true, comparison: 'above', threshold: 14.4, windowMinutes: 60, forMinutes: 0, repeatMinutes: 0, minCount: 20, notifyResolved: true }).subscribe();
        }
        this.closeForm();
        this.load();
        this.open(saved.id, false);
      },
      error: (e) => this.error.set(e?.error?.error ?? 'Enregistrement impossible.'),
    });
  }

  protected remove(id: string) {
    this.api.deleteSlo(id).subscribe(() => {
      this.closeForm();
      this.load();
    });
  }
}
