import { Component, OnDestroy, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsFunnel, AnalyticsFunnelStep } from '../core/models';
import { readSetting, writeSetting } from '../core/settings';
import { NumPipe } from '../core/pipes/num-pipe';

/** Entonnoir de conversion : visiteurs franchissant chaque étape (page ou événement), dans l'ordre. */
@Component({
  selector: 'wl-audience-funnel',
  imports: [FormsModule, NumPipe],
  template: `
    <div class="grid">
      <section class="panel editor">
        <div class="panel-head"><h2>Étapes</h2><span class="spacer"></span><span class="muted small">* = joker (ex. /blog/*)</span></div>
        <div class="panel-body">
          @for (s of steps(); track $index; let i = $index) {
            <div class="step">
              <span class="n">{{ i + 1 }}</span>
              <select [ngModel]="s.type" (ngModelChange)="update(i, { type: $event })" aria-label="Type d'étape">
                <option value="url">Page</option>
                <option value="event">Événement</option>
              </select>
              <input [ngModel]="s.value" (ngModelChange)="update(i, { value: $event })" [placeholder]="s.type === 'url' ? '/tarifs' : 'inscription'" aria-label="Valeur" />
              @if (steps().length > 2) {
                <button class="btn ghost" (click)="remove(i)" title="Retirer l'étape">✕</button>
              }
            </div>
          }
          <div class="actions">
            <button class="btn ghost" (click)="add()">+ Ajouter une étape</button>
            <span class="spacer"></span>
            <label class="small muted">Fenêtre <input type="number" min="1" [ngModel]="windowMinutes()" (ngModelChange)="windowMinutes.set(+$event || 60)" class="win" /> min</label>
            <button class="btn primary" (click)="run()">Analyser</button>
          </div>
        </div>
      </section>

      <section class="panel result">
        @if (result(); as r) {
          @if (r.steps.length < 2) {
            <div class="empty">Définissez au moins deux étapes.</div>
          } @else {
            <div class="panel-head">
              <h2>Conversion globale : {{ r.counts[0] ? pct(r.counts[r.counts.length - 1], r.counts[0]) : '–' }}</h2>
            </div>
            <div class="panel-body">
              @for (s of r.steps; track $index; let i = $index) {
                <div class="fstep" [style.--i]="i">
                  <div class="fhead">
                    <span class="muted small">{{ i + 1 }}</span>
                    <span class="ellipsis grow"><span class="muted">{{ s.type === 'url' ? 'Page' : 'Événement' }}</span> {{ s.value }}</span>
                    <strong class="num">{{ r.counts[i] | num }}</strong>
                    <span class="muted small num">{{ pct(r.counts[i], r.counts[0]) }}</span>
                  </div>
                  <div class="fbar"><i [style.width.%]="r.counts[0] ? (r.counts[i] / r.counts[0]) * 100 : 0"></i></div>
                  @if (i > 0 && r.counts[i - 1]) {
                    <div class="drop small muted">{{ pct(r.counts[i - 1] - r.counts[i], r.counts[i - 1]) }} d'abandon depuis l'étape précédente</div>
                  }
                </div>
              }
            </div>
          }
        } @else {
          <div class="empty">Chargement…</div>
        }
      </section>
    </div>
  `,
  styles: `
    .grid { display: grid; grid-template-columns: 420px minmax(0, 1fr); gap: 14px; align-items: start; }
    .step { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
    .step select { width: 110px; flex: none; }
    .step input { flex: 1; }
    .n { width: 20px; height: 20px; display: inline-grid; place-items: center; border-radius: 50%; border: 1px solid var(--border); font: 600 11px var(--sans); color: var(--text-2); flex: none; }
    .actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .win { width: 64px; }
    .fstep { margin-bottom: 16px; animation: step-in .4s ease-out both; animation-delay: calc(var(--i) * 80ms); }
    .fhead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
    .grow { flex: 1; min-width: 0; }
    .fbar { height: 22px; background: var(--surface-3); border-radius: var(--radius); overflow: hidden; }
    .fbar i { display: block; height: 100%; background: var(--accent); opacity: .85; transition: width .6s ease-out; }
    .drop { margin-top: 4px; }
    @keyframes step-in { from { opacity: 0; transform: translateY(4px); } }
    @media (max-width: 1000px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  `,
})
export class AudienceFunnel implements OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  readonly filters = input.required<Record<string, string>>();

  protected readonly steps = signal<AnalyticsFunnelStep[]>(loadSteps());
  protected readonly windowMinutes = signal(60);
  protected readonly result = signal<AnalyticsFunnel | null>(null);
  private sub?: Subscription;

  constructor() {
    effect(() => {
      this.filters();
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      untracked(() => this.run());
    });
  }

  protected update(i: number, change: Partial<AnalyticsFunnelStep>) {
    this.steps.update((list) => list.map((s, j) => (j === i ? { ...s, ...change } : s)));
  }

  protected add() {
    this.steps.update((list) => [...list, { type: 'event', value: '' }]);
  }

  protected remove(i: number) {
    this.steps.update((list) => list.filter((_, j) => j !== i));
  }

  protected run() {
    const steps = this.steps();
    writeSetting('wolflog.funnel', JSON.stringify(steps));
    this.sub?.unsubscribe();
    this.sub = this.api.analyticsFunnel(this.state.range(), this.state.service(), this.filters(), steps.filter((s) => s.value.trim()), this.windowMinutes())
      .subscribe((r) => this.result.set(r));
  }

  protected pct(n: number, total: number) {
    return total ? `${Math.round((n / total) * 100)} %` : '–';
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }
}

function loadSteps(): AnalyticsFunnelStep[] {
  try {
    const saved = JSON.parse(readSetting('wolflog.funnel', '')) as AnalyticsFunnelStep[];
    if (Array.isArray(saved) && saved.length >= 2) return saved;
  } catch {
    /* réglage absent ou invalide */
  }
  return [{ type: 'url', value: '/' }, { type: 'event', value: '' }];
}
