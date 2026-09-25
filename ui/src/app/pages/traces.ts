import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api, TraceSummary } from '../core/api';
import { AppState } from '../core/state';
import { DurPipe, TimePipe } from '../core/format';

@Component({
  selector: 'wl-traces',
  imports: [FormsModule, DurPipe, TimePipe],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Traces</h1>
        <input [ngModel]="text()" (ngModelChange)="typed($event)" placeholder="Opération, ex. GET /api/orders" class="op" aria-label="Opération" />
        <input [ngModel]="minMs()" (ngModelChange)="minMs.set($event || null)" type="number" min="0" placeholder="Plus lentes que (ms)" class="min" aria-label="Durée minimale" />
        <div class="seg">
          <button [class.on]="!errorsOnly()" (click)="errorsOnly.set(false)">Toutes</button>
          <button [class.on]="errorsOnly()" (click)="errorsOnly.set(true)">En erreur</button>
        </div>
        <span class="spacer"></span>
        <span class="muted small">{{ traces().length }} trace(s), plus récentes en premier</span>
      </div>

      <section class="panel">
        @if (traces().length) {
          <table class="list">
            <thead>
              <tr><th>Début</th><th>Opération</th><th>Service</th><th class="r">Spans</th><th class="r">Durée</th><th class="bar-col"></th></tr>
            </thead>
            <tbody>
              @for (t of traces(); track t.traceId) {
                <tr class="click" (click)="open(t)">
                  <td class="mono small muted nowrap">{{ t.start | time: true }}</td>
                  <td class="op-cell">
                    <span class="mono ellipsis">{{ t.rootName }}</span>
                    @if (t.errors) { <span class="tag err">{{ t.errors }} erreur{{ t.errors > 1 ? 's' : '' }}</span> }
                  </td>
                  <td class="nowrap">{{ t.rootService }}@if (t.services > 1) { <span class="muted"> +{{ t.services - 1 }}</span> }</td>
                  <td class="r">{{ t.spans }}</td>
                  <td class="r mono nowrap">{{ t.durationMs | dur }}</td>
                  <td class="bar-col"><div class="bar" [class.err]="t.errors > 0" [style.width.%]="(t.durationMs / maxDuration()) * 100"></div></td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loading()) {
          <div class="empty">
            Aucune trace sur cette période.
            @if (text() || minMs() || errorsOnly()) { <a (click)="reset()">Effacer les filtres</a> }
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .op { width: 260px; }
    .min { width: 150px; }
    .op-cell { max-width: 0; width: 50%; }
    .op-cell > * { vertical-align: middle; }
    .op-cell .mono { display: inline-block; max-width: calc(100% - 90px); margin-right: 8px; }
    .bar-col { width: 18%; min-width: 120px; }
    .bar { height: 4px; background: var(--accent); opacity: .7; min-width: 2px; }
    .bar.err { background: var(--danger); }
    .empty a { cursor: pointer; margin-left: 6px; }
  `,
})
export class TracesPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);
  /** Paramètre d'URL (recherche globale). */
  readonly q = input<string>('');

  protected readonly traces = signal<TraceSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly text = signal('');
  protected readonly minMs = signal<number | null>(null);
  protected readonly errorsOnly = signal(false);
  private readonly appliedText = signal('');
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private sub?: Subscription;

  protected readonly maxDuration = computed(() => Math.max(1, ...this.traces().map((t) => t.durationMs)));

  constructor() {
    effect(() => {
      const q = this.q();
      untracked(() => {
        this.text.set(q ?? '');
        this.appliedText.set((q ?? '').trim());
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      this.appliedText();
      this.minMs();
      this.errorsOnly();
      untracked(() => this.load());
    });
  }

  protected typed(value: string) {
    this.text.set(value);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.appliedText.set(value.trim()), 300);
  }

  protected reset() {
    this.text.set('');
    this.appliedText.set('');
    this.minMs.set(null);
    this.errorsOnly.set(false);
  }

  private load() {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.sub = this.api
      .traces(this.state.range(), { service: this.state.service(), q: this.appliedText(), minMs: this.minMs(), errors: this.errorsOnly() })
      .subscribe({
        next: (t) => {
          this.traces.set(t);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  open(t: TraceSummary) {
    this.router.navigate(['/traces', t.traceId], { queryParams: { around: t.start } });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
    if (this.typingTimer) clearTimeout(this.typingTimer);
  }
}
