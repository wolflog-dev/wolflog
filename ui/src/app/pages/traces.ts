import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api, TraceSummary } from '../core/api';
import { AppState } from '../core/state';
import { DurPipe, TimePipe } from '../core/format';

@Component({
  selector: 'vg-traces',
  imports: [FormsModule, DurPipe, TimePipe],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <form class="page-head" (ngSubmit)="apply()">
        <h1>Traces</h1>
        <span class="spacer"></span>
        <input name="q" [(ngModel)]="text" placeholder="Opération, ex. GET /api/orders" class="op" />
        <input name="min" [(ngModel)]="minMs" type="number" min="0" placeholder="Durée min. (ms)" class="min" />
        <label class="check"><input type="checkbox" name="err" [(ngModel)]="errorsOnly" (change)="apply()" /> En erreur uniquement</label>
        <button class="btn" type="submit">Filtrer</button>
      </form>

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
          <div class="empty">Aucune trace sur cette période.</div>
        }
      </section>
    </div>
  `,
  styles: `
    .op { width: 260px; }
    .min { width: 130px; }
    .op-cell { max-width: 0; width: 50%; }
    .op-cell > * { vertical-align: middle; }
    .op-cell .mono { display: inline-block; max-width: calc(100% - 90px); margin-right: 8px; }
    .bar-col { width: 18%; min-width: 120px; }
    .bar { height: 4px; background: var(--accent); opacity: .7; min-width: 2px; }
    .bar.err { background: var(--danger); }
  `,
})
export class TracesPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);
  protected readonly traces = signal<TraceSummary[]>([]);
  protected readonly loading = signal(false);
  protected text = '';
  protected minMs: number | null = null;
  protected errorsOnly = false;
  private readonly filters = signal({ text: '', minMs: null as number | null, errorsOnly: false });
  private sub?: Subscription;

  protected readonly maxDuration = computed(() => Math.max(1, ...this.traces().map((t) => t.durationMs)));

  constructor() {
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.filters();
      untracked(() => this.load());
    });
  }

  apply() {
    this.filters.set({ text: this.text, minMs: this.minMs, errorsOnly: this.errorsOnly });
  }

  private load() {
    this.sub?.unsubscribe();
    this.loading.set(true);
    const f = this.filters();
    this.sub = this.api
      .traces(this.state.range(), { service: this.state.service(), q: f.text, minMs: f.minMs, errors: f.errorsOnly })
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
}
