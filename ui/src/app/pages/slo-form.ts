import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { Api } from '../core/api';
import { Probe, Slo, SloStatus } from '../core/models';
import { AppState } from '../core/app-state';
import { Toasts } from '../core/toasts';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';

function blankSlo(): Slo {
  return {
    id: '', name: '', kind: 'availability', source: 'http', service: null, route: null, probeId: null,
    targetPercent: 99.9, latencyMs: 500, windowDays: 30, description: null,
  };
}

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? '–' : v.toLocaleString('fr-FR', { maximumFractionDigits: digits });

const TARGETS = [99, 99.5, 99.9, 99.95, 99.99];

/** Fenêtres glissantes proposées, avec ce qu'elles impliquent. */
const WINDOW_DAYS = [
  { value: 7, label: '7 jours', desc: 'Réagit vite aux incidents récents' },
  { value: 28, label: '28 jours', desc: 'Quatre semaines pleines' },
  { value: 30, label: '30 jours', desc: 'Un mois : le choix courant' },
  { value: 90, label: '90 jours', desc: 'Un trimestre, très stable' },
];

/** Temps d'indisponibilité toléré pour une cible et une fenêtre (« 43 min », « 7,2 h »). */
function downtime(targetPercent: number, windowDays: number): string {
  const minutes = (windowDays * 24 * 60 * (100 - targetPercent)) / 100;
  return minutes >= 120 ? `${fmt(minutes / 60, 1)} h` : `${fmt(minutes, 0)} min`;
}

/** Création / modification d'un objectif : ce qu'on mesure, ce qu'est un succès, la cible, puis le nom et l'alerte. */
@Component({
  selector: 'wl-slo-form',
  imports: [FormsModule, RouterLink, CountUp, NavIcon, RichOption],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/slos" class="small crumb"><wl-nav-icon name="slos" [size]="14" />Objectifs</a>
        <span class="muted">/</span>
        <h1>{{ s().id ? 'Modifier l’objectif' : 'Nouvel objectif' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/slos"><wl-nav-icon name="close" [size]="15" />Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">
          @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="s().id ? 'check' : 'plus'" [size]="15" /> }
          {{ s().id ? 'Enregistrer' : 'Créer l’objectif' }}
        </button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step" [class.done]="ready()">
            <div class="step-head"><span class="num">1</span><h2>Que mesurer ?</h2></div>
            <div class="step-body">
              <div class="choices two">
                <button type="button" class="choice kind" [class.on]="s().source === 'http'" (click)="patch({ source: 'http' })">
                  <span class="k-icon"><wl-nav-icon name="requests" [size]="17" /></span>
                  <strong>Les requêtes HTTP d'un service</strong><span class="k-hint">Ce que vivent réellement les utilisateurs de l'application</span>
                </button>
                <button type="button" class="choice kind" [class.on]="s().source === 'probe'" (click)="patch({ source: 'probe', kind: 'availability' })">
                  <span class="k-icon"><wl-nav-icon name="uptime" [size]="17" /></span>
                  <strong>Les contrôles d'une sonde</strong><span class="k-hint">Disponibilité vue de l'extérieur, même sans trafic</span>
                </button>
              </div>
              @if (s().source === 'http') {
                <div class="options" animate.enter="swap-in">
                  <label class="field">Service
                    <select [ngModel]="s().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                      <option value="" wlOpt="choisir…" icon="search" tone="muted"></option>
                      @for (x of services(); track x) { <option [value]="x" [wlOpt]="x" avatar></option> }
                    </select></label>
                  <label class="field">Route (facultatif) <input [ngModel]="s().route ?? ''" (ngModelChange)="patch({ route: $event || null })" placeholder="ex. /api/orders" />
                    <span class="muted small">Vide : toutes les requêtes du service.</span></label>
                </div>
              } @else {
                <label class="field" animate.enter="swap-in">Sonde
                  <select [ngModel]="s().probeId ?? ''" (ngModelChange)="patch({ probeId: $event || null })">
                    <option value="" wlOpt="choisir…" icon="search" tone="muted"></option>
                    @for (p of probes(); track p.id) { <option [value]="p.id" [wlOpt]="p.name" [icon]="p.type === 'tcp' ? 'server' : 'globe'" [desc]="p.target"></option> }
                  </select>
                  @if (!probes().length) {
                    <span class="small none">Aucune sonde. <a class="inline-cta" routerLink="/uptime/new"><wl-nav-icon name="plus" [size]="13" />Créer une sonde</a></span>
                  }
                </label>
              }
            </div>
          </section>

          @if (s().source === 'http') {
            <section class="panel step done" animate.enter="step-in">
              <div class="step-head"><span class="num">2</span><h2>Qu'est-ce qu'une requête réussie ?</h2></div>
              <div class="step-body">
                <div class="choices two">
                  <button type="button" class="choice kind" [class.on]="s().kind === 'availability'" (click)="patch({ kind: 'availability' })">
                    <span class="k-icon"><wl-nav-icon name="shield" [size]="17" /></span>
                    <strong>Sans erreur serveur</strong><span class="k-hint">Tout sauf les réponses 5xx et les exceptions</span>
                  </button>
                  <button type="button" class="choice kind" [class.on]="s().kind === 'latency'" (click)="patch({ kind: 'latency' })">
                    <span class="k-icon"><wl-nav-icon name="timer" [size]="17" /></span>
                    <strong>Assez rapide</strong><span class="k-hint">Répondue en moins d'une durée donnée</span>
                  </button>
                </div>
                @if (s().kind === 'latency') {
                  <div class="sentence" animate.enter="swap-in"><span>Plus rapide que</span>
                    <span class="unit-input"><input type="number" class="num-in" min="1" [ngModel]="s().latencyMs" (ngModelChange)="patch({ latencyMs: +$event })" /><em>ms</em></span></div>
                }
              </div>
            </section>
          }

          <section class="panel step done">
            <div class="step-head"><span class="num">{{ s().source === 'http' ? 3 : 2 }}</span><h2>Quelle cible ?</h2></div>
            <div class="step-body">
              <div class="sentence">
                <span class="unit-input"><input type="number" class="num-in" step="any" min="1" max="99.999" [ngModel]="s().targetPercent" (ngModelChange)="patch({ targetPercent: +$event })" /><em>%</em></span>
                <span>de réussite sur</span>
                <select [ngModel]="s().windowDays" (ngModelChange)="patch({ windowDays: +$event })">
                  @for (w of windows; track w.value) { <option [value]="w.value" [wlOpt]="w.label" icon="calendar" [desc]="w.desc"></option> }
                </select>
                <span>glissants</span>
              </div>
              <div class="presets">
                <span class="muted small">Courants :</span>
                @for (t of targets; track t) {
                  <button type="button" class="preset" [class.on]="s().targetPercent === t" (click)="patch({ targetPercent: t })"
                          [title]="'≈ ' + downtimeFor(t) + ' d’indisponibilité tolérée sur ' + s().windowDays + ' jours'">{{ pctLabel(t) }}</button>
                }
              </div>
              <p class="allow"><wl-nav-icon name="timer" [size]="14" /><span>Budget d'erreur : {{ allowance() }}</span></p>
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">{{ s().source === 'http' ? 4 : 3 }}</span><h2>Nom et alerte</h2></div>
            <div class="step-body">
              <label class="field">Nom <input [ngModel]="s().name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></label>
              @if (!s().id) {
                <label class="check"><input type="checkbox" class="switch" [(ngModel)]="withAlert" /> Créer l'alerte « budget consommé trop vite » (14,4× sur 1 h)</label>
              }
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <div class="sum">
              <span class="sum-icon"><wl-nav-icon name="target" [size]="18" /></span>
              <p class="phrase">{{ autoName() }}.</p>
            </div>
            <p class="muted small">{{ allowance() }}</p>
          </div>
          <div class="block">
            <h3>Aujourd'hui</h3>
            @if (!ready()) {
              <span class="muted small hint-line"><wl-nav-icon name="info" [size]="13" />{{ s().source === 'probe' ? 'Choisissez la sonde.' : 'Choisissez le service.' }}</span>
            } @else if (preview(); as p) {
              <div class="today" [class.stale]="stale()">
                @if (!p.total) {
                  <span class="muted small">Pas encore de données sur la période.</span>
                } @else {
                  <div class="verdict" [class]="p.state"><wl-nav-icon [name]="p.state === 'ok' ? 'ok' : 'warning'" [size]="14" />{{ stateLabel(p.state) }}</div>
                  <div class="mini">
                    <div><span>Mesuré</span><strong [wlCountUp]="fmt(p.sli, 3) + ' %'"></strong></div>
                    <div><span>Budget restant</span><strong [class.danger]="(p.budgetRemaining ?? 100) < 0" [wlCountUp]="fmt(p.budgetRemaining, 1) + ' %'"></strong></div>
                  </div>
                  <div class="bar" [title]="'Budget d’erreur restant : ' + fmt(p.budgetRemaining, 1) + ' %'">
                    <span [class]="p.state" [style.transform]="'scaleX(' + budgetScale(p) + ')'"></span>
                  </div>
                  <div class="small muted">sur {{ p.total.toLocaleString('fr-FR') }} évènements ({{ p.bad.toLocaleString('fr-FR') }} en échec)</div>
                }
              </div>
            } @else if (previewFailed()) {
              <span class="muted small hint-line"><wl-nav-icon name="warning" [size]="13" />Aperçu impossible pour ces critères.</span>
            } @else {
              <div class="sk" aria-label="Calcul en cours"><i class="skeleton" style="width: 55%; height: 18px"></i><i class="skeleton" style="width: 85%; height: 30px"></i><i class="skeleton" style="width: 70%"></i></div>
            }
          </div>
          @if (error()) { <div class="block"><span class="danger small err" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy()">
              @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="s().id ? 'check' : 'plus'" [size]="15" /> }
              {{ s().id ? 'Enregistrer' : 'Créer l’objectif' }}
            </button>
            <a class="btn" routerLink="/slos">Annuler</a>
            <span class="spacer"></span>
            @if (s().id) {
              @if (confirmDelete()) {
                <span class="confirm" animate.enter="confirm-in">
                  <button class="btn danger-btn" (click)="remove()" [disabled]="deleting()"><wl-nav-icon name="trash" [size]="14" />Confirmer</button>
                  <button class="btn ghost icon" (click)="confirmDelete.set(false)" title="Ne pas supprimer" aria-label="Ne pas supprimer"><wl-nav-icon name="close" [size]="14" /></button>
                </span>
              } @else {
                <button class="btn ghost del" (click)="confirmDelete.set(true)"><wl-nav-icon name="trash" [size]="14" />Supprimer</button>
              }
            }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .crumb { display: inline-flex; align-items: center; gap: 6px; }
    .crumb wl-nav-icon { transition: transform .35s var(--spring); }
    .crumb:hover wl-nav-icon { transform: translateX(-2px) rotate(-10deg); }

    /* Choix : carte avec icône qui pivote au survol et se remplit une fois choisie. */
    .choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .choice.kind { grid-template-columns: 34px minmax(0, 1fr); column-gap: 12px; row-gap: 2px; align-items: center; }
    .kind .k-icon { grid-row: span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: var(--accent);
      background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
      transition: transform .4s var(--spring), color .25s, background-color .25s; }
    .kind:hover .k-icon { transform: scale(1.1) rotate(-8deg); }
    .kind.on .k-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 16px -8px var(--accent);
      animation: icon-pop .5s var(--spring); }
    @keyframes icon-pop { 40% { transform: scale(1.18) rotate(-10deg); } }
    .swap-in { animation: swap-in .35s var(--ease) backwards; }
    @keyframes swap-in { from { opacity: 0; transform: translateY(-4px); } }
    .step-in { animation: step-in .4s var(--ease) backwards; }
    @keyframes step-in { from { opacity: 0; transform: translateY(-6px); } }
    .none { display: inline-flex; align-items: center; gap: 2px; color: var(--text-2); }
    .inline-cta { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; font-weight: 600; }

    .num-in { width: 90px; }
    .unit-input { display: inline-flex; align-items: center; gap: 6px; }
    .unit-input em { font-style: normal; color: var(--text-2); }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 240px; }

    /* Cibles courantes en pastilles ; budget d'erreur. */
    .presets { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .presets .muted { margin-right: 4px; }
    .preset { height: 26px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
      font: 600 11.5px var(--mono); cursor: pointer; transition: transform .3s var(--spring), border-color .2s, color .2s, background-color .2s; }
    .preset:hover { transform: translateY(-2px); color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
    .preset:active { transform: scale(.94); }
    .preset.on { color: var(--on-accent); border-color: transparent; background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 6px 16px -8px var(--accent); animation: preset-pop .4s var(--spring); }
    @keyframes preset-pop { 40% { transform: scale(1.1); } }
    .allow { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
    .allow wl-nav-icon { color: var(--accent); }
    label.check { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-1); cursor: pointer; }

    /* Résumé : verdict, chiffres animés et budget en barre. */
    .sum { display: flex; align-items: flex-start; gap: 12px; }
    .sum-icon { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 11px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -10px var(--accent); }
    .phrase { font-size: 13.5px; line-height: 1.5; min-width: 0; }
    .hint-line { display: inline-flex; align-items: center; gap: 6px; }
    .today { display: grid; gap: 8px; transition: opacity .2s; }
    .today.stale { opacity: .5; }
    .sk { display: grid; gap: 8px; }
    .verdict { display: inline-flex; align-items: center; gap: 8px; justify-self: start; padding: 4px 11px; border-radius: 999px; font-weight: 650;
      color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); animation: verdict-in .4s var(--spring); }
    .verdict.warning { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
    .verdict.breached { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    @keyframes verdict-in { from { opacity: 0; transform: scale(.92); } }
    .mini { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .mini > div { display: grid; gap: 2px; padding: 8px 11px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .mini span { font-size: 11.5px; color: var(--text-3); }
    .mini strong { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .bar { height: 6px; border-radius: 3px; overflow: hidden; background: var(--surface-3); }
    .bar span { display: block; height: 100%; background: var(--ok); transform-origin: left; transition: transform .7s var(--ease); animation: bar-grow .9s var(--ease) backwards; }
    .bar span.warning { background: var(--warn); }
    .bar span.breached { background: var(--danger); }
    @keyframes bar-grow { from { transform: scaleX(0); } }
    .err { display: inline-flex; align-items: center; gap: 6px; }
    .fade-in { animation: verdict-in .35s var(--spring); }

    /* Suppression en deux temps, bouton de confirmation rouge. */
    .actions { flex-wrap: wrap; }
    .confirm { display: inline-flex; gap: 4px; margin-left: auto; }
    .confirm-in { animation: confirm-in .35s var(--spring); }
    @keyframes confirm-in { from { opacity: 0; transform: translateX(10px) scale(.94); } }
    .danger-btn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent);
      --ripple: color-mix(in srgb, var(--danger) 45%, transparent); }
    .danger-btn:hover { color: var(--on-accent); background: var(--danger); border-color: var(--danger); }
    .del:hover { color: var(--danger); }
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(1turn); } }
    p { margin: 0; }
  `,
})
export class SloFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly state = inject(AppState);
  private readonly toasts = inject(Toasts);
  /** /slos/:id/edit ; /slos/new?probe=… */
  readonly id = input<string>('');
  readonly probe = input<string>('');

  protected readonly s = signal<Slo>(blankSlo());
  protected readonly services = signal<string[]>([]);
  protected readonly probes = signal<Probe[]>([]);
  protected readonly preview = signal<SloStatus | null>(null);
  /** Aperçu affiché mais recalculé après une modification (estompé en attendant). */
  protected readonly stale = signal(false);
  protected readonly previewFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly confirmDelete = signal(false);
  protected readonly deleting = signal(false);
  protected readonly targets = TARGETS;
  protected readonly windows = WINDOW_DAYS;
  protected readonly fmt = fmt;
  protected withAlert = true;
  private readonly previews = new Subject<Slo>();

  protected readonly ready = computed(() => (this.s().source === 'probe' ? !!this.s().probeId : !!this.s().service));
  protected readonly autoName = computed(() => {
    const s = this.s();
    const probe = this.probes().find((p) => p.id === s.probeId)?.name ?? 'une sonde';
    const what = s.source === 'probe'
      ? `contrôles de ${probe} réussis`
      : `requêtes de ${s.service ?? '…'}${s.route ? ' ' + s.route : ''} ${s.kind === 'latency' ? `en moins de ${fmt(s.latencyMs, 0)} ms` : 'sans erreur'}`;
    return `${fmt(s.targetPercent, 3)} % des ${what} sur ${s.windowDays} jours`;
  });
  protected readonly allowance = computed(() => {
    const f = this.s();
    return `${fmt(100 - f.targetPercent, 3)} % d'échecs tolérés, soit environ ${downtime(f.targetPercent, f.windowDays)} d'indisponibilité sur ${f.windowDays} jours.`;
  });

  constructor() {
    this.api.services({ from: '7d', to: '' }).subscribe((l) => {
      this.services.set(l.map((x) => x.name));
      // Service présélectionné : celui du filtre global, ou le seul connu.
      if (!this.id() && !this.s().service && this.s().source === 'http') {
        const only = l.length === 1 ? l[0].name : null;
        const service = this.state.service() || only;
        if (service) this.patch({ service });
      }
    });
    this.api.probes({ from: '1h', to: '' }, 1).subscribe((p) => this.probes.set(p.map((x) => x.probe)));
    effect(() => {
      const id = this.id();
      const probe = this.probe();
      untracked(() => {
        if (id) {
          this.api.slo(id).subscribe({ next: (d) => this.s.set({ ...d.slo }), error: () => this.error.set('Objectif introuvable.') });
        } else if (probe) {
          this.patch({ source: 'probe', probeId: probe, kind: 'availability' });
        }
      });
    });
    this.previews
      .pipe(debounceTime(400), switchMap((slo) => this.api.previewSlo(slo).pipe(catchError(() => {
        this.previewFailed.set(true);
        return of(null);
      }))))
      .subscribe((p) => {
        this.preview.set(p);
        this.stale.set(false);
        if (p) this.previewFailed.set(false);
      });
    // Aperçu recalculé à chaque modification ; l'ancien reste visible (estompé) jusqu'à la réponse.
    effect(() => {
      const slo = this.s();
      untracked(() => {
        if (this.ready()) {
          this.stale.set(true);
          this.previewFailed.set(false);
          this.previews.next({ ...slo, name: slo.name || 'aperçu' });
        } else {
          this.preview.set(null);
        }
      });
    });
  }

  /** Indisponibilité tolérée pour une cible, sur la fenêtre choisie. */
  protected downtimeFor(target: number) {
    return downtime(target, this.s().windowDays);
  }

  /** Part du budget restant pour la barre (0 à 1). */
  protected budgetScale(p: SloStatus) {
    return Math.max(0, Math.min(100, p.budgetRemaining ?? 0)) / 100;
  }

  protected patch(change: Partial<Slo>) {
    this.s.update((s) => ({ ...s, ...change }));
  }

  protected pctLabel(v: number) {
    return fmt(v, 3) + ' %';
  }

  protected stateLabel(state: string) {
    return ({ ok: 'Objectif tenu', warning: 'À surveiller', breached: 'Objectif non tenu' } as Record<string, string>)[state] ?? state;
  }

  protected save() {
    this.busy.set(true);
    this.error.set('');
    const s = this.s();
    const isNew = !s.id;
    this.api.saveSlo({ ...s, name: s.name.trim() || this.autoName() }).subscribe({
      next: (saved) => {
        if (isNew && this.withAlert) {
          this.api.saveAlert({ name: `${saved.name} : budget consommé trop vite`, kind: 'slo', targetId: saved.id, severity: 'critical', channels: [],
            enabled: true, comparison: 'above', threshold: 14.4, windowMinutes: 60, forMinutes: 0, repeatMinutes: 0, minCount: 20, notifyResolved: true })
            .subscribe({ error: (e) => this.toasts.error(e?.error?.error ?? 'Objectif créé, mais son alerte n’a pas pu être créée.') });
        }
        this.toasts.ok(isNew ? (this.withAlert ? 'Objectif créé, avec son alerte' : 'Objectif créé') : 'Objectif enregistré', 'slos');
        this.router.navigate(['/slos', saved.id]);
      },
      error: (e) => {
        this.busy.set(false);
        const message = e?.error?.error ?? 'Enregistrement impossible.';
        this.error.set(message);
        this.toasts.error(message);
      },
    });
  }

  protected remove() {
    this.deleting.set(true);
    this.api.deleteSlo(this.s().id).subscribe({
      next: () => {
        this.toasts.ok('Objectif supprimé', 'trash');
        this.router.navigate(['/slos']);
      },
      error: (e) => {
        this.deleting.set(false);
        this.confirmDelete.set(false);
        this.toasts.error(e?.error?.error ?? 'Suppression impossible.');
      },
    });
  }
}
