import { Component, OnDestroy, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsFunnel, AnalyticsFunnelStep } from '../core/models';
import { readSetting, writeSetting } from '../core/settings';
import { Toasts } from '../core/toasts';
import { NumPipe } from '../core/pipes/num-pipe';
import { CountUp } from './count-up';
import { NavIcon } from './nav-icon';
import { RichOption } from './rich-option';
import { Skeleton } from './skeleton';

/** Étape en cours d'édition : un identifiant stable, pour que la ligne retirée (et elle seule) s'efface. */
type EditedStep = AnalyticsFunnelStep & { id: number };

let nextStepId = 1;
const withId = (s: AnalyticsFunnelStep): EditedStep => ({ ...s, id: nextStepId++ });

/** Entonnoir de conversion : visiteurs franchissant chaque étape (page ou événement), dans l'ordre. */
@Component({
  selector: 'wl-audience-funnel',
  imports: [FormsModule, NumPipe, CountUp, NavIcon, RichOption, Skeleton],
  template: `
    <div class="grid">
      <section class="panel editor">
        <div class="panel-head"><h2>Étapes</h2><span class="spacer"></span><span class="muted small joker" title="Ex. /blog/* : toutes les pages du blog">* = joker (ex. /blog/*)</span></div>
        <div class="panel-body">
          <div class="steps">
            @for (s of steps(); track s.id; let i = $index; let last = $last) {
              <div class="step" [class.last]="last" animate.enter="step-in" animate.leave="step-out">
                <span class="n">{{ i + 1 }}</span>
                <select class="type" [ngModel]="s.type" (ngModelChange)="update(i, { type: $event })" aria-label="Type d'étape">
                  <option value="url" wlOpt="Page" icon="page" desc="Adresse visitée (joker * accepté)"></option>
                  <option value="event" wlOpt="Événement" icon="bolt" tone="warn" desc="wolflog.track(…) ou data-wolflog-event"></option>
                </select>
                <input [ngModel]="s.value" (ngModelChange)="update(i, { value: $event })" [placeholder]="s.type === 'url' ? '/tarifs' : 'inscription'"
                       aria-label="Valeur" spellcheck="false" (keydown.enter)="run()" />
                @if (steps().length > 2) {
                  <button class="btn ghost icon" (click)="remove(i)" title="Retirer l'étape" aria-label="Retirer l'étape"><wl-nav-icon name="close" [size]="14" /></button>
                }
              </div>
            }
          </div>
          <div class="actions">
            <button class="btn ghost" (click)="add()"><wl-nav-icon name="plus" [size]="14" />Ajouter une étape</button>
            <span class="spacer"></span>
            <label class="small muted window" title="Délai maximal entre la première et la dernière étape">
              <wl-nav-icon name="clock" [size]="13" />Fenêtre
              <input type="number" min="1" [ngModel]="windowMinutes()" (ngModelChange)="windowMinutes.set(+$event || 60)" class="win" /> min</label>
            <button class="btn primary" (click)="run()" [disabled]="loading()">
              <wl-nav-icon [name]="loading() ? 'refresh' : 'play'" [class.spin]="loading()" [size]="13" />Analyser
            </button>
          </div>
        </div>
      </section>

      <section class="panel result" [class.stale]="loading() && result()">
        @if (result(); as r) {
          @if (r.steps.length < 2) {
            <div class="empty">
              <strong>Définissez au moins deux étapes.</strong>
              <span>Par exemple une page d'arrivée puis un événement d'inscription.</span>
            </div>
          } @else {
            <div class="panel-head">
              <h2>Conversion globale</h2>
              <strong class="rate" [wlCountUp]="r.counts[0] ? pct(r.counts[r.counts.length - 1], r.counts[0]) : '–'"></strong>
              <span class="spacer"></span>
              <span class="muted small">{{ r.counts[0] | num }} → {{ r.counts[r.counts.length - 1] | num }} visiteur{{ r.counts[r.counts.length - 1] > 1 ? 's' : '' }}</span>
            </div>
            <div class="panel-body">
              @for (s of r.steps; track $index; let i = $index) {
                @if (i > 0 && r.counts[i - 1]) {
                  <div class="drop small" [style.--i]="i">
                    <wl-nav-icon name="arrow-down" [size]="12" />
                    <span class="loss">−{{ pct(r.counts[i - 1] - r.counts[i], r.counts[i - 1]) }}</span>
                    <span class="muted">d'abandon depuis l'étape précédente</span>
                  </div>
                }
                <div class="fstep" [style.--i]="i">
                  <div class="fhead">
                    <span class="fn">{{ i + 1 }}</span>
                    <span class="ftype" [class.ev]="s.type === 'event'" [title]="s.type === 'url' ? 'Page' : 'Événement'">
                      <wl-nav-icon [name]="s.type === 'url' ? 'page' : 'bolt'" [size]="12" />
                    </span>
                    <span class="ellipsis grow" [title]="s.value">{{ s.value }}</span>
                    <strong class="count" [wlCountUp]="r.counts[i] | num"></strong>
                    <span class="muted small share">{{ pct(r.counts[i], r.counts[0]) }}</span>
                  </div>
                  <div class="fbar"><i [style.--w]="r.counts[0] ? r.counts[i] / r.counts[0] : 0"></i></div>
                </div>
              }
            </div>
          }
        } @else {
          <div class="panel-head"><h2>Conversion globale</h2></div>
          <wl-skeleton [rows]="5" />
        }
      </section>
    </div>
  `,
  styles: `
    .grid { display: grid; grid-template-columns: 440px minmax(0, 1fr); gap: 14px; align-items: start; }
    .joker { font-family: var(--mono); }
    .steps { display: grid; gap: 8px; }
    .step { position: relative; display: flex; gap: 6px; align-items: center; }
    /* Trait qui relie les numéros d'étape. */
    .step:not(.last)::before { content: ''; position: absolute; left: 11px; top: 28px; height: 16px; width: 1px;
      background: linear-gradient(color-mix(in srgb, var(--accent) 45%, transparent), var(--border)); }
    .step-in { animation: step-in .4s var(--spring); }
    .step-out { animation: step-out .2s ease-in forwards; }
    @keyframes step-in { from { opacity: 0; transform: translateY(-8px) scale(.98); } }
    @keyframes step-out { to { opacity: 0; transform: translateX(14px); } }
    .step select.type { width: 148px; flex: none; }
    .step input { flex: 1; min-width: 0; }
    .n { width: 23px; height: 23px; display: inline-grid; place-items: center; border-radius: 50%; flex: none; font: 650 11px var(--sans);
      color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
    .btn.icon { width: 32px; padding: 0; justify-content: center; flex: none; }
    .btn.icon:hover { color: var(--danger); }
    .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .window { display: inline-flex; align-items: center; gap: 6px; }
    .win { width: 64px; }
    .btn wl-nav-icon.spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .result { transition: opacity .3s; }
    .result.stale { opacity: .65; }
    .rate { font-size: 20px; font-weight: 700; letter-spacing: -.02em; color: var(--accent); font-variant-numeric: tabular-nums; }
    .fstep { animation: step-rise .45s var(--ease) backwards; animation-delay: calc(var(--i) * 90ms); }
    @keyframes step-rise { from { opacity: 0; transform: translateY(6px); } }
    .fhead { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; }
    .fn { flex: none; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; font: 650 10.5px var(--sans); color: var(--text-2);
      background: var(--surface-3); }
    .ftype { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 7px; color: var(--accent); background: var(--accent-soft); }
    .ftype.ev { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
    .grow { flex: 1; min-width: 0; font-weight: 550; }
    .count { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .share { width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
    /* Barre de l'étape : largeur par transform (scaleX), qui pousse à l'affichage puis suit les actualisations. */
    .fbar { height: 24px; overflow: hidden; border-radius: 8px; background: var(--surface-3); }
    .fbar i { display: block; height: 100%; border-radius: inherit; transform-origin: left; transform: scaleX(var(--w));
      background: linear-gradient(90deg, var(--accent), var(--accent-2)); box-shadow: inset 0 1px 0 var(--highlight);
      transition: transform .7s var(--ease); animation: grow .9s var(--ease) backwards; animation-delay: calc(var(--i) * 90ms + 80ms); }
    @keyframes grow { from { transform: scaleX(0); } }
    .drop { display: flex; align-items: center; gap: 6px; margin: 6px 0 8px 29px; animation: step-rise .45s var(--ease) backwards;
      animation-delay: calc(var(--i) * 90ms - 40ms); }
    .drop wl-nav-icon { color: var(--danger); }
    .loss { padding: 0 7px; border-radius: 999px; font: 650 11px/18px var(--sans); color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .empty { display: grid; justify-items: center; gap: 4px; }
    .empty strong { color: var(--text-1); }
    @media (max-width: 1000px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  `,
})
export class AudienceFunnel implements OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  private readonly toasts = inject(Toasts);
  readonly filters = input.required<Record<string, string>>();

  protected readonly steps = signal<EditedStep[]>(loadSteps().map(withId));
  protected readonly windowMinutes = signal(60);
  protected readonly result = signal<AnalyticsFunnel | null>(null);
  protected readonly loading = signal(false);
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
    this.steps.update((list) => [...list, withId({ type: 'event', value: '' })]);
  }

  protected remove(i: number) {
    this.steps.update((list) => list.filter((_, j) => j !== i));
  }

  protected run() {
    const steps: AnalyticsFunnelStep[] = this.steps().map(({ type, value }) => ({ type, value }));
    writeSetting('wolflog.funnel', JSON.stringify(steps));
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.sub = this.api.analyticsFunnel(this.state.range(), this.state.service(), this.filters(), steps.filter((s) => s.value.trim()), this.windowMinutes())
      .subscribe({
        next: (r) => {
          this.result.set(r);
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.toasts.error(e?.error?.error ?? 'Analyse de l’entonnoir impossible.');
        },
      });
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
