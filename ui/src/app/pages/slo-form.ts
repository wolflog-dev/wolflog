import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { Api } from '../core/api';
import { Probe, Slo, SloStatus } from '../core/models';
import { AppState } from '../core/app-state';

function blankSlo(): Slo {
  return {
    id: '', name: '', kind: 'availability', source: 'http', service: null, route: null, probeId: null,
    targetPercent: 99.9, latencyMs: 500, windowDays: 30, description: null,
  };
}

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? '–' : v.toLocaleString('fr-FR', { maximumFractionDigits: digits });

const TARGETS = [99, 99.5, 99.9, 99.95, 99.99];

/** Création / modification d'un objectif : ce qu'on mesure, ce qu'est un succès, la cible, puis le nom et l'alerte. */
@Component({
  selector: 'wl-slo-form',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/slos" class="small">Objectifs</a>
        <span class="muted">/</span>
        <h1>{{ s().id ? 'Modifier l’objectif' : 'Nouvel objectif' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/slos">Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">{{ s().id ? 'Enregistrer' : 'Créer l’objectif' }}</button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Que mesurer ?</h2></div>
            <div class="step-body">
              <div class="choices two">
                <button type="button" class="choice" [class.on]="s().source === 'http'" (click)="patch({ source: 'http' })">
                  <strong>Les requêtes HTTP d'un service</strong><span>Ce que vivent réellement les utilisateurs de l'application</span>
                </button>
                <button type="button" class="choice" [class.on]="s().source === 'probe'" (click)="patch({ source: 'probe', kind: 'availability' })">
                  <strong>Les contrôles d'une sonde</strong><span>Disponibilité vue de l'extérieur, même sans trafic</span>
                </button>
              </div>
              @if (s().source === 'http') {
                <div class="options">
                  <label class="field">Service
                    <select [ngModel]="s().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                      <option value="">choisir…</option>
                      @for (x of services(); track x) { <option [value]="x">{{ x }}</option> }
                    </select></label>
                  <label class="field">Route (facultatif) <input [ngModel]="s().route ?? ''" (ngModelChange)="patch({ route: $event || null })" placeholder="ex. /api/orders" />
                    <span class="muted small">Vide : toutes les requêtes du service.</span></label>
                </div>
              } @else {
                <label class="field">Sonde
                  <select [ngModel]="s().probeId ?? ''" (ngModelChange)="patch({ probeId: $event || null })">
                    <option value="">choisir…</option>
                    @for (p of probes(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                  </select>
                  @if (!probes().length) { <span class="small">Aucune sonde. <a routerLink="/uptime/new">Créer une sonde</a></span> }
                </label>
              }
            </div>
          </section>

          @if (s().source === 'http') {
            <section class="panel step done">
              <div class="step-head"><span class="num">2</span><h2>Qu'est-ce qu'une requête réussie ?</h2></div>
              <div class="step-body">
                <div class="choices two">
                  <button type="button" class="choice" [class.on]="s().kind === 'availability'" (click)="patch({ kind: 'availability' })">
                    <strong>Sans erreur serveur</strong><span>Tout sauf les réponses 5xx et les exceptions</span>
                  </button>
                  <button type="button" class="choice" [class.on]="s().kind === 'latency'" (click)="patch({ kind: 'latency' })">
                    <strong>Assez rapide</strong><span>Répondue en moins d'une durée donnée</span>
                  </button>
                </div>
                @if (s().kind === 'latency') {
                  <div class="sentence"><span>Plus rapide que</span>
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
                  <option [value]="7">7 jours</option><option [value]="28">28 jours</option><option [value]="30">30 jours</option><option [value]="90">90 jours</option>
                </select>
                <span>glissants</span>
              </div>
              <div class="presets small">
                <span class="muted">Courants :</span>
                @for (t of targets; track t) { <button type="button" class="link" [class.on]="s().targetPercent === t" (click)="patch({ targetPercent: t })">{{ pctLabel(t) }}</button> }
              </div>
              <p class="muted small">Budget d'erreur : {{ allowance() }}</p>
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">{{ s().source === 'http' ? 4 : 3 }}</span><h2>Nom et alerte</h2></div>
            <div class="step-body">
              <label class="field">Nom <input [ngModel]="s().name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></label>
              @if (!s().id) {
                <label class="check"><input type="checkbox" [(ngModel)]="withAlert" /> Créer l'alerte « budget consommé trop vite » (14,4× sur 1 h)</label>
              }
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <p class="phrase">{{ autoName() }}.</p>
            <p class="muted small">{{ allowance() }}</p>
          </div>
          <div class="block">
            <h3>Aujourd'hui</h3>
            @if (!ready()) {
              <span class="muted small">{{ s().source === 'probe' ? 'Choisissez la sonde.' : 'Choisissez le service.' }}</span>
            } @else if (preview(); as p) {
              @if (!p.total) {
                <span class="muted small">Pas encore de données sur la période.</span>
              } @else {
                <div class="verdict" [class]="p.state">{{ stateLabel(p.state) }}</div>
                <div class="small">Mesuré : <strong>{{ fmt(p.sli, 3) }} %</strong> sur {{ p.total.toLocaleString('fr-FR') }} évènements ({{ p.bad.toLocaleString('fr-FR') }} en échec)</div>
                <div class="small">Budget restant : <strong [class.danger]="(p.budgetRemaining ?? 100) < 0">{{ fmt(p.budgetRemaining, 1) }} %</strong></div>
              }
            } @else {
              <span class="muted small">Calcul…</span>
            }
          </div>
          @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy()">{{ s().id ? 'Enregistrer' : 'Créer l’objectif' }}</button>
            <a class="btn" routerLink="/slos">Annuler</a>
            <span class="spacer"></span>
            @if (s().id) { <button class="btn ghost" (click)="remove()">Supprimer</button> }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .num-in { width: 90px; }
    .unit-input { display: inline-flex; align-items: center; gap: 6px; }
    .unit-input em { font-style: normal; color: var(--text-2); }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 240px; }
    .presets { display: flex; gap: 12px; align-items: center; }
    .link { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; }
    .link.on { color: var(--text-1); font-weight: 600; }
    label.check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-1); cursor: pointer; }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    .verdict { font-weight: 600; }
    .verdict.ok { color: var(--ok); }
    .verdict.warning { color: var(--warn); }
    .verdict.breached { color: var(--danger); }
    p { margin: 0; }
  `,
})
export class SloFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly state = inject(AppState);
  /** /slos/:id/edit ; /slos/new?probe=… */
  readonly id = input<string>('');
  readonly probe = input<string>('');

  protected readonly s = signal<Slo>(blankSlo());
  protected readonly services = signal<string[]>([]);
  protected readonly probes = signal<Probe[]>([]);
  protected readonly preview = signal<SloStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly targets = TARGETS;
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
    const minutes = (f.windowDays * 24 * 60 * (100 - f.targetPercent)) / 100;
    const time = minutes >= 120 ? `${fmt(minutes / 60, 1)} h` : `${fmt(minutes, 0)} min`;
    return `${fmt(100 - f.targetPercent, 3)} % d'échecs tolérés, soit environ ${time} d'indisponibilité sur ${f.windowDays} jours.`;
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
      .pipe(debounceTime(400), switchMap((slo) => this.api.previewSlo(slo).pipe(catchError(() => of(null)))))
      .subscribe((p) => this.preview.set(p));
    effect(() => {
      const slo = this.s();
      untracked(() => {
        this.preview.set(null);
        if (this.ready()) this.previews.next({ ...slo, name: slo.name || 'aperçu' });
      });
    });
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
            enabled: true, comparison: 'above', threshold: 14.4, windowMinutes: 60, forMinutes: 0, repeatMinutes: 0, minCount: 20, notifyResolved: true }).subscribe();
        }
        this.router.navigate(['/slos', saved.id]);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
      },
    });
  }

  protected remove() {
    this.api.deleteSlo(this.s().id).subscribe(() => this.router.navigate(['/slos']));
  }
}
