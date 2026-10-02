import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Probe, Slo, SloDetail, SloStatus } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { NumPipe } from '../core/pipes/num-pipe';
import { Chart, ChartSeries } from '../shared/chart';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? '–' : v.toLocaleString('fr-FR', { maximumFractionDigits: digits });

/**
 * Objectifs de service : chiffres clés, liste avec le budget d'erreur restant en barre, et détail d'un objectif
 * (historique du budget et de la réussite, liens vers l'alerte de consommation et les données en échec).
 */
@Component({
  selector: 'wl-slos',
  imports: [RouterLink, NumPipe, Chart, CountUp, NavIcon, Skeleton],
  host: { '(document:keydown.escape)': 'escape($event)' },
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Objectifs de service</h1>
        <span class="muted small">part d'évènements réussis sur une fenêtre glissante, et budget d'erreur restant</span>
        <span class="spacer"></span>
        @if (session.canEdit()) { <a class="btn primary" routerLink="/slos/new"><wl-nav-icon name="plus" [size]="15" />Nouvel objectif</a> }
      </div>

      @if (!loaded() || items().length) {
        <div class="stats panel">
          <div class="t-ok">
            <span><wl-nav-icon name="ok" [size]="13" />Tenus</span>
            @if (loaded()) { <strong [wlCountUp]="counts().ok"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>@if (loaded()) { sur {{ items().length }} objectif{{ items().length > 1 ? 's' : '' }} } @else { &nbsp; }</em>
          </div>
          <div class="t-warn">
            <span><wl-nav-icon name="warning" [size]="13" />À surveiller</span>
            @if (loaded()) { <strong [class.warn]="counts().warning > 0" [wlCountUp]="counts().warning"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>&nbsp;</em>
          </div>
          <div class="t-bad" [class.alarm]="counts().breached > 0">
            <span><wl-nav-icon name="errors" [size]="13" />Non tenus</span>
            @if (loaded()) { <strong [class.danger]="counts().breached > 0" [wlCountUp]="counts().breached"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>@if (loaded()) { {{ counts().breached ? 'budget épuisé' : 'aucun' }} } @else { &nbsp; }</em>
          </div>
          <div class="t-budget">
            <span><wl-nav-icon name="gauge" [size]="13" />Budget restant moyen</span>
            @if (loaded()) { <strong [wlCountUp]="pct(avgBudget(), 1)"></strong> } @else { <i class="skeleton sk-num"></i> }
            <em>budget d'erreur</em>
          </div>
        </div>
      }

      <div class="split" [class.with-side]="detail() || pending()">
        <section class="panel">
          @if (!loaded()) {
            <wl-skeleton [rows]="4" />
          } @else if (items().length) {
            <table class="list">
              <thead><tr><th>État</th><th>Objectif</th><th class="r">Mesuré</th><th class="r hide-side">Cible</th><th>Budget restant</th><th class="r hide-side">Consommation (1 h)</th><th></th></tr></thead>
              <tbody>
                @for (i of items(); track i.slo.id) {
                  <tr class="click" [class.sel]="selectedId() === i.slo.id" [class.is-bad]="i.status.state === 'breached'" (click)="open(i.slo.id)">
                    <td class="nowrap"><span class="pill" [class]="i.status.state"><wl-nav-icon [name]="stateIcon(i.status.state)" [size]="12" />{{ stateLabel(i.status.state) }}</span></td>
                    <td class="name">
                      <div class="name-row">
                        <span class="kind" [title]="i.slo.source === 'probe' ? 'Contrôles d’une sonde' : i.slo.kind === 'latency' ? 'Requêtes assez rapides' : 'Requêtes sans erreur'">
                          <wl-nav-icon [name]="i.slo.source === 'probe' ? 'uptime' : i.slo.kind === 'latency' ? 'timer' : 'requests'" [size]="14" />
                        </span>
                        <div class="name-text">
                          <div class="ellipsis" [title]="i.slo.name">{{ i.slo.name }}</div>
                          <div class="muted small ellipsis" [title]="describe(i.slo)">{{ describe(i.slo) }}</div>
                        </div>
                      </div>
                    </td>
                    <td class="r mono nowrap" [class.danger]="i.status.state === 'breached'">{{ pct(i.status.sli, 3) }}</td>
                    <td class="r mono muted nowrap hide-side">{{ pct(i.slo.targetPercent, 3) }}</td>
                    <td class="budget" [title]="'Budget d’erreur restant : ' + pct(i.status.budgetRemaining, 1)">
                      <div class="bar"><span [class]="i.status.state" [style.transform]="'scaleX(' + budgetWidth(i.status) / 100 + ')'"></span></div>
                      <span class="mono small">{{ pct(i.status.budgetRemaining, 1) }}</span>
                    </td>
                    <td class="r mono nowrap hide-side" [class.danger]="(i.status.burnRate1h ?? 0) > 14.4" [class.warn]="(i.status.burnRate1h ?? 0) > 6 && (i.status.burnRate1h ?? 0) <= 14.4"
                        title="1 = le budget serait épuisé exactement en fin de fenêtre">{{ burn(i.status.burnRate1h) }}</td>
                    <td class="chev"><wl-nav-icon name="chevron-right" [size]="15" /></td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty">
              Aucun objectif. Exemple : 99,9 % des requêtes de l'API sans erreur serveur sur 30 jours,
              soit environ 43 minutes d'indisponibilité tolérées par mois.
              @if (session.canEdit()) { <div class="cta"><a class="btn primary" routerLink="/slos/new"><wl-nav-icon name="plus" [size]="15" />Nouvel objectif</a></div> }
            </div>
          }
        </section>

        @if (detail() || pending()) {
          <aside class="panel side" animate.enter="side-in">
            @if (detail(); as d) {
              <div class="panel-head">
                <span class="pill" [class]="d.status.state"><wl-nav-icon [name]="stateIcon(d.status.state)" [size]="12" />{{ stateLabel(d.status.state) }}</span>
                <strong class="ellipsis" [title]="d.slo.name">{{ d.slo.name }}</strong>
                <span class="spacer"></span>
                @if (session.canEdit()) { <a class="btn" [routerLink]="['/slos', d.slo.id, 'edit']"><wl-nav-icon name="edit" [size]="14" />Modifier</a> }
                <button class="btn ghost icon" (click)="close()" title="Fermer (Échap)" aria-label="Fermer"><wl-nav-icon name="close" [size]="16" /></button>
              </div>
              <div class="panel-body detail" [class.stale]="pending()">
                <div class="facts small">
                  <div class="fact"><span><wl-nav-icon name="check" [size]="12" />Mesuré</span><strong [class.danger]="d.status.state === 'breached'" [wlCountUp]="pct(d.status.sli, 3)"></strong></div>
                  <div class="fact"><span><wl-nav-icon name="target" [size]="12" />Cible</span><strong>{{ pct(d.slo.targetPercent, 3) }}</strong></div>
                  <div class="fact"><span><wl-nav-icon name="gauge" [size]="12" />Budget restant</span><strong [class.danger]="(d.status.budgetRemaining ?? 100) < 0" [wlCountUp]="pct(d.status.budgetRemaining, 1)"></strong></div>
                  <div class="fact"><span><wl-nav-icon name="hash" [size]="12" />Évènements</span><strong [wlCountUp]="d.status.total | num"></strong></div>
                  <div class="fact"><span><wl-nav-icon name="warning" [size]="12" />En échec</span><strong [class.danger]="d.status.bad > 0" [wlCountUp]="d.status.bad | num"></strong></div>
                  <div class="fact"><span><wl-nav-icon name="bolt" [size]="12" />Consommation 1 h / 6 h</span><strong>{{ burn(d.status.burnRate1h) }} / {{ burn(d.status.burnRate6h) }}</strong></div>
                </div>
                <div class="budget-wide" [title]="'Budget d’erreur restant : ' + pct(d.status.budgetRemaining, 1)">
                  <div class="bar"><span [class]="d.status.state" [style.transform]="'scaleX(' + budgetWidth(d.status) / 100 + ')'"></span></div>
                </div>
                <h3>Budget d'erreur restant ({{ d.slo.windowDays }} jours)</h3>
                <wl-chart [times]="times()" [series]="budgetSeries()" [height]="130" unit="%" [legend]="false" />
                <h3>Réussite par intervalle</h3>
                <wl-chart [times]="times()" [series]="sliSeries()" [height]="110" unit="%" [legend]="false" />
                <div class="links">
                  <a class="link-chip" [routerLink]="['/alerts/new']" [queryParams]="{ kind: 'slo', target: d.slo.id }"><wl-nav-icon name="bell" [size]="13" />Créer une alerte de consommation</a>
                  @if (d.slo.source === 'http') {
                    <a class="link-chip" [routerLink]="['/requests']" [queryParams]="{ service: d.slo.service, q: d.slo.route, status: d.slo.kind === 'availability' ? 'errors' : null, minMs: d.slo.kind === 'latency' ? d.slo.latencyMs : null }"><wl-nav-icon name="requests" [size]="13" />Voir les requêtes en échec</a>
                  } @else {
                    <a class="link-chip" routerLink="/uptime"><wl-nav-icon name="uptime" [size]="13" />Voir la sonde</a>
                  }
                </div>
              </div>
            } @else {
              <div class="panel-head">
                <i class="skeleton" style="width: 76px; height: 22px; border-radius: 999px"></i>
                <i class="skeleton" style="width: 40%; height: 14px"></i>
                <span class="spacer"></span>
                <button class="btn ghost icon" (click)="close()" title="Fermer (Échap)" aria-label="Fermer"><wl-nav-icon name="close" [size]="16" /></button>
              </div>
              <wl-skeleton [rows]="7" />
            }
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    /* Chiffres clés. */
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .stats > div { display: grid; gap: 2px; align-content: start; min-width: 0; padding: 12px 16px; border-right: 1px solid var(--border-soft); }
    .stats > div:last-child { border-right: 0; }
    .stats span { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
    .stats strong { font-size: 22px; font-weight: 650; letter-spacing: -.02em; line-height: 1.25; font-variant-numeric: tabular-nums; }
    .stats em { font-style: normal; font-size: 11.5px; color: var(--text-3); }
    .t-ok wl-nav-icon { color: var(--ok); }
    .t-warn wl-nav-icon { color: var(--warn); }
    .t-bad wl-nav-icon { color: var(--text-3); }
    .t-bad.alarm wl-nav-icon { color: var(--danger); }
    .t-budget wl-nav-icon { color: var(--accent); }
    .sk-num { width: 56px; height: 22px; margin: 3px 0 2px; }
    .warn { color: var(--warn); }

    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-side { grid-template-columns: minmax(0, 1fr) minmax(440px, 42%); }
    .side { position: sticky; top: 60px; max-height: calc(100vh - 80px); overflow: auto; }
    .side-in { animation: side-in .45s var(--ease) backwards; }
    @keyframes side-in { from { opacity: 0; transform: translateX(24px); } }

    /* États en pastille : icône et couleur de l'état. */
    .pill { --tone: var(--text-3); display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px 0 8px; border-radius: 999px; flex: none;
      font: 600 11.5px/1 var(--sans); white-space: nowrap; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 26%, transparent); }
    .pill.ok { --tone: var(--ok); }
    .pill.warning { --tone: var(--warn); }
    .pill.breached { --tone: var(--danger); }
    .pill wl-nav-icon { flex: none; }

    /* Liste : type d'objectif, budget en barre qui se remplit, chevron qui glisse. */
    .name { max-width: 0; width: 36%; }
    .name-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .name-text { min-width: 0; }
    .kind { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 9px; color: var(--accent);
      background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); transition: transform .4s var(--spring); }
    tr.click:hover .kind { transform: scale(1.1) rotate(-8deg); }
    .budget { display: flex; align-items: center; gap: 8px; min-width: 150px; white-space: nowrap; }
    .split.with-side .hide-side { display: none; }
    .bar { flex: 1; height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--ok); transform-origin: left; transition: transform .7s var(--ease);
      animation: bar-grow .9s var(--ease) backwards; }
    .bar span.warning { background: var(--warn); }
    .bar span.breached { background: var(--danger); }
    @keyframes bar-grow { from { transform: scaleX(0); } }
    .chev { width: 1%; padding-left: 0; color: var(--text-3); }
    .chev wl-nav-icon { transition: transform .3s var(--spring), color .2s; }
    tr.click:hover .chev wl-nav-icon, tr.sel .chev wl-nav-icon { transform: translateX(4px); color: var(--accent); }
    tr.sel td { background: var(--row-selected); }
    tr.sel td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    tr.is-bad:not(.sel) td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
    .cta { display: flex; justify-content: center; margin-top: 16px; }

    /* Détail : faits en tuiles, liens en pastilles. */
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .btn.icon wl-nav-icon { transition: transform .35s var(--spring); }
    .btn.icon:hover wl-nav-icon { transform: rotate(90deg); }
    .detail { display: grid; gap: 10px; transition: opacity .2s; }
    .detail.stale { opacity: .5; }
    .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
    .fact { display: grid; gap: 3px; min-width: 0; padding: 8px 11px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .fact span { display: inline-flex; align-items: center; gap: 5px; color: var(--text-3); }
    .fact strong { font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .budget-wide .bar { height: 8px; border-radius: 4px; }
    h3 { margin-top: 6px; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .link-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12px;
      border: 1px solid var(--border); background: var(--surface-2); transition: transform .3s var(--spring), border-color .2s, background-color .2s; }
    .link-chip:hover { text-decoration: none; transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); background-color: var(--surface-3); }
    .link-chip wl-nav-icon { transition: transform .4s var(--spring); }
    .link-chip:hover wl-nav-icon { transform: scale(1.15) rotate(-8deg); }
    p { margin: 0; }
    @media (max-width: 1200px) {
      .split.with-side { grid-template-columns: minmax(0, 1fr); }
      .side { position: fixed; top: 0; right: 0; bottom: 0; max-height: none; width: min(600px, 100%); z-index: 60; border-radius: 0; box-shadow: var(--shadow-pop); }
    }
    @media (max-width: 900px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stats > div { border-bottom: 1px solid var(--border-soft); }
    }
  `,
})
export class SlosPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  /** /slos/:id : ouvre le détail (liens des alertes). Anciens liens ?edit=new : page de création. */
  readonly id = input<string>('');
  readonly editParam = input<string>('', { alias: 'edit' });
  readonly probe = input<string>('');

  protected readonly items = signal<{ slo: Slo; status: SloStatus }[]>([]);
  protected readonly detail = signal<SloDetail | null>(null);
  /** Objectif demandé dont le détail est en cours de chargement (le panneau s'ouvre tout de suite). */
  protected readonly pending = signal<string | null>(null);
  protected readonly probes = signal<Probe[]>([]);
  /** Première liste reçue : squelette de chargement avant. */
  protected readonly loaded = signal(false);

  protected readonly selectedId = computed(() => this.pending() ?? this.detail()?.slo.id ?? null);
  protected readonly counts = computed(() => {
    const c = { ok: 0, warning: 0, breached: 0 };
    for (const i of this.items()) c[i.status.state]++;
    return c;
  });
  protected readonly avgBudget = computed(() => {
    const known = this.items().map((i) => i.status.budgetRemaining).filter((v): v is number => v !== null && v !== undefined);
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  });

  protected readonly times = computed(() => this.detail()?.history.map((h) => h.t) ?? []);
  protected readonly budgetSeries = computed<ChartSeries[]>(() => [
    { label: 'budget restant', color: '#7fb685', values: this.detail()?.history.map((h) => h.budgetRemaining) ?? [] },
  ]);
  protected readonly sliSeries = computed<ChartSeries[]>(() => [
    { label: 'réussite', color: '#7aa2f7', values: this.detail()?.history.map((h) => h.sli) ?? [] },
  ]);
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
        if (edit === 'new') this.router.navigate(['/slos/new'], { queryParams: probe ? { probe } : {}, replaceUrl: true });
      });
    });
    this.api.probes({ from: '1h', to: '' }, 1).subscribe((p) => this.probes.set(p.map((x) => x.probe)));
  }

  private load() {
    this.api.slos().subscribe({
      next: (l) => {
        this.items.set(l);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
    const d = this.detail();
    // Réponse ignorée si un autre objectif a été ouvert entre-temps.
    if (d) this.api.slo(d.slo.id).subscribe((x) => { if (this.detail()?.slo.id === x.slo.id && !this.pending()) this.detail.set(x); });
  }

  /** Échap ferme le détail (sauf pendant une saisie). */
  protected escape(e: Event) {
    if (!this.detail() && !this.pending()) return;
    if ((e.target as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable]')) return;
    this.close();
  }

  protected describe(s: Slo) {
    const probe = this.probes().find((p) => p.id === s.probeId)?.name ?? 'une sonde';
    const what = s.source === 'probe'
      ? `contrôles de ${probe} réussis`
      : `requêtes de ${s.service ?? '?'}${s.route ? ' ' + s.route : ''} ${s.kind === 'latency' ? `en moins de ${fmt(s.latencyMs, 0)} ms` : 'sans erreur'}`;
    return `${fmt(s.targetPercent, 3)} % des ${what} sur ${s.windowDays} j`;
  }

  protected stateIcon(s: string) {
    return s === 'ok' ? 'ok' : 'warning';
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

  /** Ouvre le détail (ou le referme sur un second clic) ; le panneau s'affiche avant la réponse. */
  protected open(id: string, toggle = true) {
    if (toggle && this.selectedId() === id) return this.close();
    this.pending.set(id);
    this.api.slo(id).subscribe({
      next: (d) => {
        if (this.pending() !== id) return;
        this.detail.set(d);
        this.pending.set(null);
      },
      error: () => {
        if (this.pending() !== id) return;
        this.pending.set(null);
        this.toasts.error('Objectif introuvable.');
      },
    });
  }

  protected close() {
    this.detail.set(null);
    this.pending.set(null);
    if (this.id()) this.router.navigate(['/slos']);
  }
}
