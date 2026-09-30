import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsBreakdownRow, AnalyticsRealtime } from '../core/models';
import { countryName, dimensionValue } from '../core/audience-labels';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { NumPipe } from '../core/pipes/num-pipe';

/** Temps réel : visiteurs actifs (5 min), pages vues par minute et activité des 30 dernières minutes. */
@Component({
  selector: 'wl-audience-live',
  imports: [NumPipe, AgoPipe],
  template: `
    <div class="live-grid">
      <section class="panel hero">
        <h3>Visiteurs actifs</h3>
        <div class="big"><span class="dot" [class.idle]="!data()?.active"></span><span class="num">{{ data()?.active ?? 0 | num }}</span></div>
        <p class="muted small">{{ data()?.visitors ?? 0 | num }} visiteur{{ (data()?.visitors ?? 0) > 1 ? 's' : '' }} sur les 30 dernières minutes</p>
        <div class="bars" title="Pages vues par minute (30 dernières minutes)">
          @for (v of data()?.perMinute ?? []; track $index) {
            <span [style.height.%]="barHeight(v)" [title]="v + ' page(s) vue(s)'"></span>
          }
        </div>
      </section>

      <section class="panel feed">
        <div class="panel-head"><h2>Activité en direct</h2><span class="spacer"></span><span class="muted small">actualisée toutes les 5 s</span></div>
        <div class="items">
          @for (e of data()?.recent ?? []; track e.ts + e.visitor + e.path) {
            <div class="item">
              <span class="kind" [class.ev]="e.kind === 2">{{ e.kind === 2 ? 'ÉVT' : 'PAGE' }}</span>
              <div class="body">
                <div class="main ellipsis">{{ e.kind === 2 ? e.eventName : e.path }}</div>
                <div class="sub ellipsis muted small">
                  {{ e.kind === 2 ? 'sur ' + e.path + ' · ' : '' }}{{ where(e.country, e.browser, e.os) }}{{ e.referrer ? ' · via ' + e.referrer : '' }}
                  · visiteur #{{ e.visitor }}
                </div>
              </div>
              <span class="muted small nowrap">{{ e.ts | ago }}</span>
            </div>
          } @empty {
            <div class="empty">En attente de visiteurs…</div>
          }
        </div>
      </section>
    </div>

    <div class="cols3">
      @for (list of lists(); track list.title) {
        <section class="panel">
          <div class="panel-head"><h2>{{ list.title }}</h2></div>
          <div class="panel-body">
            @for (r of list.rows; track r.value) {
              <div class="line"><span class="ellipsis">{{ label(list.dimension, r.value) }}</span><span class="num">{{ (list.dimension === 'page' ? r.count : r.visitors) | num }}</span></div>
            } @empty {
              <div class="muted small">Rien pour le moment</div>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: grid; gap: 14px; }
    .live-grid { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; }
    .hero { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
    .big { display: flex; align-items: center; gap: 12px; font-size: 44px; font-weight: 700; letter-spacing: -.03em; line-height: 1.1; }
    .dot { position: relative; width: 10px; height: 10px; border-radius: 50%; background: var(--ok); }
    .dot::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: var(--ok); animation: ping 1.8s ease-out infinite; }
    .dot.idle { background: var(--text-3); }
    .dot.idle::after { display: none; }
    @keyframes ping { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(2.6); opacity: 0; } }
    p { margin: 0; }
    .bars { margin-top: auto; display: flex; align-items: flex-end; gap: 2px; height: 90px; padding-top: 12px; }
    .bars span { flex: 1; min-height: 1px; background: var(--accent); opacity: .75; border-radius: 2px 2px 0 0; transition: height .4s ease-out; }
    .items { max-height: 420px; overflow: auto; }
    .item { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--border-soft); animation: item-in .4s ease-out both; }
    .kind { font: 600 10px var(--mono); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--border); color: var(--text-3); }
    .kind.ev { color: var(--warn); border-color: currentColor; }
    .body { flex: 1; min-width: 0; }
    .main { font-weight: 500; }
    .cols3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .line { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--border-soft); }
    .line:last-child { border-bottom: 0; }
    @keyframes item-in { from { opacity: 0; transform: translateY(-4px); } }
    @media (max-width: 900px) { .live-grid { grid-template-columns: minmax(0, 1fr); } }
    @media (prefers-reduced-motion: reduce) { .item { animation: none; } .dot::after { animation: none; } }
  `,
})
export class AudienceLive implements OnInit, OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  protected readonly data = signal<AnalyticsRealtime | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;
  private sub?: Subscription;

  protected readonly lists = computed(() => {
    const d = this.data();
    const lists: { title: string; dimension: string; rows: AnalyticsBreakdownRow[] }[] = [
      { title: 'Pages (30 min)', dimension: 'page', rows: d?.pages ?? [] },
      { title: 'Référents (30 min)', dimension: 'referrer', rows: d?.referrers ?? [] },
      { title: 'Pays (30 min)', dimension: 'country', rows: d?.countries ?? [] },
    ];
    return lists;
  });

  ngOnInit() {
    this.load();
    this.timer = setInterval(() => this.load(), 5000);
  }

  private load() {
    this.sub?.unsubscribe();
    this.sub = this.api.analyticsRealtime(this.state.service()).subscribe((d) => this.data.set(d));
  }

  protected barHeight(v: number) {
    const max = Math.max(1, ...(this.data()?.perMinute ?? [1]));
    return Math.round((v / max) * 100);
  }

  protected where(country: string | null, browser: string | null, os: string | null) {
    return [country ? countryName(country) : null, browser, os].filter(Boolean).join(' · ') || 'Visiteur';
  }

  protected label(dimension: string, value: string | null) {
    return dimensionValue(dimension, value);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.sub?.unsubscribe();
  }
}
