import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { AnalyticsBreakdownRow, AnalyticsRealtime } from '../core/models';
import { countryName, dimensionValue } from '../core/audience-labels';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { CountUp } from './count-up';
import { NavIcon } from './nav-icon';
import { Skeleton } from './skeleton';

/** Teinte stable d'un visiteur (ou d'un utilisateur connecté) : ses événements successifs portent la même pastille. */
function visitorHue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Temps réel : visiteurs et utilisateurs connectés actifs (5 min), pages vues par minute et activité des 30 dernières minutes. */
@Component({
  selector: 'wl-audience-live',
  imports: [NumPipe, AgoPipe, CountUp, NavIcon, Skeleton],
  template: `
    <div class="live-grid">
      <section class="panel hero">
        <div class="hero-head">
          <h3>Visiteurs actifs</h3>
          <span class="live" [class.idle]="!data()?.active">{{ data()?.active ? 'En direct' : 'Calme' }}</span>
        </div>
        <div class="big"><strong class="count" [wlCountUp]="(data()?.active ?? 0) | num"></strong></div>
        <p class="muted small">{{ data()?.visitors ?? 0 | num }} visiteur{{ (data()?.visitors ?? 0) > 1 ? 's' : '' }} sur les 30 dernières minutes</p>
        @if (data()?.users; as users) {
          <p class="connected" title="Utilisateurs identifiés par l'application, actifs depuis 5 minutes (et sur les 30 dernières minutes)">
            <wl-nav-icon name="users" [size]="13" />
            <strong class="num">{{ data()!.activeUsers | num }}</strong>
            utilisateur{{ data()!.activeUsers > 1 ? 's' : '' }} connecté{{ data()!.activeUsers > 1 ? 's' : '' }}
            <span class="muted">· {{ users | num }} sur 30 min</span>
          </p>
        }
        <div class="bars" title="Pages vues par minute (30 dernières minutes)">
          @for (v of data()?.perMinute ?? []; track $index; let i = $index) {
            <span [style.--h]="barHeight(v) / 100" [style.--i]="i" [title]="v + ' page(s) vue(s)'"></span>
          }
        </div>
        <div class="axis"><span>il y a 30 min</span><span>maintenant</span></div>
      </section>

      <section class="panel feed">
        <div class="panel-head">
          <h2>Activité en direct</h2>
          <span class="spacer"></span>
          <span class="refresh muted small" title="Prochaine actualisation">
            <span class="track">@for (b of [beat()]; track b) {<i></i>}</span>actualisée toutes les 5 s
          </span>
        </div>
        <div class="items">
          @if (!data()) {
            <wl-skeleton [rows]="6" />
          } @else {
            @for (e of data()!.recent; track e.ts + e.visitor + e.path) {
              <div class="item">
                <span class="kind" [class.ev]="e.kind === 2" [title]="e.kind === 2 ? 'Événement' : 'Page vue'">
                  <wl-nav-icon [name]="e.kind === 2 ? 'bolt' : 'page'" [size]="14" />
                </span>
                <div class="body">
                  <div class="main ellipsis" [title]="(e.kind === 2 ? e.eventName : e.path) ?? ''">{{ e.kind === 2 ? e.eventName : e.path }}</div>
                  <div class="sub ellipsis muted small">
                    {{ e.kind === 2 ? 'sur ' + e.path + ' · ' : '' }}{{ where(e.country, e.browser, e.os) }}{{ e.referrer ? ' · via ' + e.referrer : '' }}
                    · {{ e.user ? 'utilisateur #' + e.user : 'visiteur #' + e.visitor }}
                  </div>
                </div>
                <span class="visitor" [style.--hue]="hue(e.user ?? e.visitor)" [title]="e.user ? 'Utilisateur connecté #' + e.user : 'Visiteur #' + e.visitor"></span>
                <span class="muted small nowrap" [title]="exact(e.ts)">{{ e.ts | ago }}</span>
              </div>
            } @empty {
              <div class="empty">
                <strong>En attente de visiteurs…</strong>
                <span>Chaque page vue et chaque événement apparaîtront ici dans les secondes qui suivent.</span>
              </div>
            }
          }
        </div>
      </section>
    </div>

    <div class="cols3">
      @for (list of lists(); track list.title; let li = $index) {
        <section class="panel" [style.--li]="li">
          <div class="panel-head"><span class="list-icon"><wl-nav-icon [name]="list.icon" [size]="13" /></span><h2>{{ list.title }}</h2></div>
          <div class="panel-body">
            @if (!data()) {
              <wl-skeleton [rows]="3" />
            } @else {
              @for (r of list.rows; track r.value; let j = $index) {
                <div class="line" [style.--w]="share(list, r)" [style.--j]="j">
                  <i class="bar"></i>
                  <span class="ellipsis" [class.muted]="r.value === null" [title]="label(list.dimension, r.value)">{{ label(list.dimension, r.value) }}</span>
                  <span class="num">{{ (list.dimension === 'page' ? r.count : r.visitors) | num }}</span>
                </div>
              } @empty {
                <div class="none muted small"><wl-nav-icon name="clock" [size]="14" />Rien pour le moment</div>
              }
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: grid; gap: 14px; }
    .live-grid { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; }
    .hero { padding: 14px 16px 12px; display: flex; flex-direction: column; gap: 6px; }
    .hero-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .live { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 999px; font: 650 10px/19px var(--sans);
      text-transform: uppercase; letter-spacing: .06em; color: var(--ok); background: color-mix(in srgb, var(--ok) 13%, transparent); }
    .live.idle { color: var(--text-3); background: var(--surface-2); }
    .big { display: flex; align-items: center; gap: 14px; }
    .count { font-size: 46px; font-weight: 750; letter-spacing: -.03em; line-height: 1.1; font-variant-numeric: tabular-nums;
      background: linear-gradient(90deg, var(--text-1), color-mix(in srgb, var(--accent) 70%, var(--text-1)));
      -webkit-background-clip: text; background-clip: text; color: transparent; }
    p { margin: 0; }
    .connected { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
    .connected wl-nav-icon { color: var(--accent); }
    .connected strong { font-weight: 650; }
    /* Pages vues par minute : hauteur par transform (scaleY), la minute en cours mise en avant. */
    .bars { margin-top: auto; display: flex; align-items: flex-end; gap: 2px; height: 90px; padding-top: 12px; }
    .bars span { flex: 1; height: 100%; border-radius: 3px 3px 1px 1px; transform-origin: bottom; transform: scaleY(max(.02, var(--h)));
      background: linear-gradient(to top, color-mix(in srgb, var(--accent) 55%, transparent), var(--accent)); opacity: .7;
      transition: transform .5s var(--ease), opacity .2s; animation: bar-in .6s var(--ease) backwards; animation-delay: calc(var(--i) * 12ms); }
    .bars span:hover { opacity: 1; }
    .bars span:last-child { opacity: 1; background: linear-gradient(to top, var(--accent), var(--accent-3)); }
    @keyframes bar-in { from { transform: scaleY(0); } }
    .axis { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--text-3); }

    .refresh { display: inline-flex; align-items: center; gap: 8px; }
    /* Jauge de la prochaine actualisation : recréée à chaque réponse, elle se remplit en 5 s. */
    .track { position: relative; width: 34px; height: 3px; overflow: hidden; border-radius: 2px; background: var(--surface-3); }
    .track i { position: absolute; inset: 0; background: var(--accent); transform-origin: left; animation: refill 5s linear forwards; }
    @keyframes refill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    .items { max-height: 420px; overflow: auto; }
    .item { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--border-soft); transition: background-color .15s;
      animation: item-in .45s var(--spring) backwards; }
    .item:hover { background-color: var(--row-hover); }
    .kind { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--accent); background: var(--accent-soft); }
    .kind.ev { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
    .body { flex: 1; min-width: 0; }
    .main { font-weight: 550; }
    .visitor { flex: none; width: 9px; height: 9px; border-radius: 50%; background: hsl(var(--hue) 70% 58%);
      box-shadow: 0 0 0 3px hsl(var(--hue) 70% 58% / .2); }
    .empty { display: grid; justify-items: center; gap: 4px; }
    .empty strong { color: var(--text-1); }

    .cols3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 14px; }
    .cols3 > section { animation: item-in .45s var(--ease) backwards; animation-delay: calc(var(--li) * 60ms + 80ms); }
    .list-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; color: var(--accent); background: var(--accent-soft); }
    .panel-body wl-skeleton { padding: 0; }
    .line { position: relative; display: flex; justify-content: space-between; gap: 10px; padding: 4px 6px; border-radius: 6px; }
    .line > span { position: relative; }
    .line .bar { position: absolute; inset: 1px 0; border-radius: inherit; background: var(--accent-soft); transform-origin: left; transform: scaleX(var(--w));
      transition: transform .6s var(--ease); animation: grow .7s var(--ease) backwards; animation-delay: calc(var(--j) * 30ms); }
    @keyframes grow { from { transform: scaleX(0); } }
    .none { display: flex; align-items: center; gap: 6px; }
    @keyframes item-in { from { opacity: 0; transform: translateY(-6px); } }
    @media (max-width: 900px) { .live-grid { grid-template-columns: minmax(0, 1fr); } }
  `,
})
export class AudienceLive implements OnInit, OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  protected readonly data = signal<AnalyticsRealtime | null>(null);
  /** Incrémenté à chaque réponse : relance la jauge d'actualisation. */
  protected readonly beat = signal(0);
  protected readonly hue = visitorHue;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sub?: Subscription;

  protected readonly lists = computed(() => {
    const d = this.data();
    const lists: { title: string; dimension: string; icon: string; rows: AnalyticsBreakdownRow[] }[] = [
      { title: 'Pages (30 min)', dimension: 'page', icon: 'page', rows: d?.pages ?? [] },
      { title: 'Référents (30 min)', dimension: 'referrer', icon: 'link', rows: d?.referrers ?? [] },
      { title: 'Pays (30 min)', dimension: 'country', icon: 'globe', rows: d?.countries ?? [] },
    ];
    return lists;
  });

  ngOnInit() {
    this.load();
    this.timer = setInterval(() => this.load(), 5000);
  }

  private load() {
    this.sub?.unsubscribe();
    this.sub = this.api.analyticsRealtime(this.state.service()).subscribe((d) => {
      this.data.set(d);
      this.beat.update((b) => b + 1);
    });
  }

  protected barHeight(v: number) {
    const max = Math.max(1, ...(this.data()?.perMinute ?? [1]));
    return Math.round((v / max) * 100);
  }

  /** Part d'une ligne par rapport à la plus grande de sa liste (0 à 1). */
  protected share(list: { dimension: string; rows: AnalyticsBreakdownRow[] }, r: AnalyticsBreakdownRow) {
    const value = (x: AnalyticsBreakdownRow) => (list.dimension === 'page' ? x.count : x.visitors);
    const max = Math.max(1, ...list.rows.map(value));
    return (value(r) / max).toFixed(4);
  }

  /** Date complète pour l'infobulle : « mercredi 1 octobre 2026 à 14:32:05 ». */
  protected exact(iso: string) {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
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
