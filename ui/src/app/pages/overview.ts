import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Subscription, catchError, forkJoin, of } from 'rxjs';
import { Api } from '../core/api';
import { Deployment, Overview } from '../core/models';
import { AppState } from '../core/app-state';
import { Deployments } from '../core/deployments';
import { Session } from '../core/session';
import { ErrorStatusTag } from '../shared/error-status-tag';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { DurPipe } from '../core/pipes/dur-pipe';
import { LEVEL_COLORS, LEVELS } from '../core/format';
import { NumPipe } from '../core/pipes/num-pipe';
import { Chart, ChartSeries } from '../shared/chart';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { hue, initials } from '../shared/rich-option';

/** Point d'attention affiché en tête de page (alertes, sondes, objectifs, santé). */
interface AttentionItem {
  count: number;
  label: string;
  level: string;
  icon: string;
  link: string;
  query?: Record<string, string>;
  detail?: string;
}

@Component({
  selector: 'wl-overview',
  imports: [Chart, NumPipe, DurPipe, AgoPipe, RouterLink, ErrorStatusTag, CountUp, NavIcon],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Vue d'ensemble</h1>
        <span class="period small"><wl-nav-icon name="clock" [size]="13" />{{ state.label() }}</span>
      </div>

      <!-- En ce moment : ce qui demande de l'attention, sans avoir à ouvrir chaque page. -->
      @if (attention(); as a) {
        <div class="now panel" [class.calm]="!a.items.length">
          @if (a.items.length) {
            @for (i of a.items; track i.label; let n = $index) {
              <a class="now-item" [class]="i.level" [style.--i]="n" [routerLink]="i.link" [queryParams]="i.query ?? {}" [title]="i.detail ?? ''">
                <span class="now-icon"><wl-nav-icon [name]="i.icon" [size]="16" /></span>
                <span class="now-text">
                  <span><strong>{{ i.count }}</strong> {{ i.label }}</span>
                  @if (i.detail) { <span class="muted small ellipsis">{{ i.detail }}</span> }
                </span>
                <wl-nav-icon name="chevron-right" [size]="14" class="go" />
              </a>
            }
          } @else {
            <wl-nav-icon name="ok" [size]="15" class="ok-icon" />
            <span>Tout va bien{{ a.summary ? ' : ' + a.summary : '' }}.</span>
          }
        </div>
      } @else {
        <div class="now panel calm" aria-busy="true"><i class="skeleton" style="width: 10px; height: 10px; border-radius: 50%"></i><i class="skeleton" style="width: 280px; height: 11px"></i></div>
      }

      @if (data(); as d) {
        <div class="stats panel">
          <a class="tile" routerLink="/logs" title="Ouvrir les logs">
            <span class="label"><wl-nav-icon name="logs" [size]="13" />Logs</span>
            <strong [wlCountUp]="d.logs | num"></strong>
            <em>sur la période</em>
            <wl-nav-icon name="arrow-right" [size]="14" class="go" />
          </a>
          <a class="tile" [class.alert]="d.errors > 0" routerLink="/logs" [queryParams]="{ level: 'error' }" title="Ouvrir les logs en erreur">
            <span class="label"><wl-nav-icon name="errors" [size]="13" />Erreurs</span>
            <strong [class.danger]="d.errors > 0" [wlCountUp]="d.errors | num"></strong>
            <em>{{ errorRate() }}</em>
            <wl-nav-icon name="arrow-right" [size]="14" class="go" />
          </a>
          <a class="tile" [class.crashed]="d.crashes > 0" routerLink="/errors" [queryParams]="{ q: 'crash:true' }" title="Ouvrir les erreurs ayant provoqué un crash">
            <span class="label"><wl-nav-icon name="crash" [size]="13" />Crashs</span>
            <strong [class.crash]="d.crashes > 0" [wlCountUp]="d.crashes | num"></strong>
            <em>{{ d.crashes > 0 ? 'à examiner' : 'aucun' }}</em>
            <wl-nav-icon name="arrow-right" [size]="14" class="go" />
          </a>
          <a class="tile" routerLink="/traces" title="Ouvrir les traces">
            <span class="label"><wl-nav-icon name="traces" [size]="13" />Traces</span>
            <strong [wlCountUp]="d.traces | num"></strong>
            <em>{{ d.spans | num }} spans</em>
            <wl-nav-icon name="arrow-right" [size]="14" class="go" />
          </a>
          <div class="tile">
            <span class="label"><wl-nav-icon name="timer" [size]="13" />Latence p95</span>
            <strong [wlCountUp]="d.p95Ms | dur"></strong>
            <em>requêtes entrantes</em>
          </div>
        </div>

        <section class="panel">
          <div class="panel-head">
            <h2 class="with-icon"><wl-nav-icon name="chart-bar" [size]="15" />Logs par niveau</h2>
            <span class="spacer"></span>
            <span class="muted small hint"><wl-nav-icon name="cursor" [size]="13" />glisser pour zoomer</span>
          </div>
          <div class="panel-body">
            <wl-chart [times]="times()" [series]="series()" kind="bars" [stacked]="true" [height]="180" (rangeSelect)="zoom($event)" />
          </div>
        </section>

        <div class="cols">
          <section class="panel">
            <div class="panel-head">
              <h2 class="with-icon"><wl-nav-icon name="server" [size]="15" />Services</h2>
              @if (d.services.length) { <span class="count">{{ d.services.length }}</span> }
              <span class="spacer"></span>
              <a routerLink="/map" class="small more">Carte des services<wl-nav-icon name="arrow-right" [size]="13" /></a>
            </div>
            @if (d.services.length) {
              <table class="list">
                <thead><tr><th>Nom</th><th class="r">Logs</th><th class="r">Erreurs</th><th class="r">Spans</th><th class="r">p95</th><th>Dernier déploiement</th><th>Dernier envoi</th></tr></thead>
                <tbody>
                  @for (s of d.services; track s.name) {
                    <tr class="click" (click)="openService(s.name)">
                      <td class="svc-cell">
                        <span class="svc">
                          <span class="avatar" [style.--hue]="hueOf(s.name)">{{ initialsOf(s.name) }}</span>
                          <span class="ellipsis" [title]="s.name">{{ s.name }}</span>
                        </span>
                      </td>
                      <td class="r">{{ s.logs | num }}</td>
                      <td class="r">@if (s.errors > 0) { <span class="err-chip">{{ s.errors | num }}</span> } @else { <span class="muted">0</span> }</td>
                      <td class="r">{{ s.spans | num }}</td>
                      <td class="r nowrap">{{ s.p95Ms | dur }}</td>
                      <td class="small nowrap">
                        @if (lastDeploy().get(s.name); as dep) {
                          <span class="mono version" [title]="dep.version">{{ dep.version }}</span><span class="muted">{{ dep.at | ago }}</span>
                        }
                      </td>
                      <td class="muted nowrap">
                        <span class="seen" [class.live]="fresh(s.lastSeen)" [title]="fresh(s.lastSeen) ? 'Données reçues dans les 5 dernières minutes' : ''">{{ s.lastSeen | ago }}</span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="empty">
                <p>Aucune donnée reçue sur cette période.</p>
                <a class="btn primary" routerLink="/admin/keys/new"><wl-nav-icon name="plus" [size]="14" />Connecter une application</a>
              </div>
            }
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2 class="with-icon"><wl-nav-icon name="errors" [size]="15" />Erreurs à traiter</h2>
              @if (d.topErrors.length) { <span class="count danger">{{ d.topErrors.length }}</span> }
              <span class="spacer"></span>
              <a routerLink="/errors" class="small more">Tout voir<wl-nav-icon name="arrow-right" [size]="13" /></a>
            </div>
            @if (d.topErrors.length) {
              <table class="list">
                <thead><tr><th>Exception</th><th class="r">Nombre</th><th>Dernière</th></tr></thead>
                <tbody>
                  @for (e of d.topErrors; track e.fingerprint) {
                    <tr class="click" [routerLink]="['/errors', e.fingerprint]">
                      <td class="exc">
                        <div class="ellipsis">@if (e.crashes) { <span class="tag crash">crash</span> } <wl-error-status [status]="e.status" /> <span class="mono" [title]="e.exceptionType">{{ e.exceptionType }}</span></div>
                        <div class="muted small ellipsis" [title]="e.message ?? ''">{{ e.message }}</div>
                      </td>
                      <td class="r"><strong class="count-cell">{{ e.count | num }}</strong></td>
                      <td class="muted nowrap">{{ e.lastSeen | ago }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="empty">
                <p>Aucune erreur à traiter sur cette période.</p>
                <p class="small">Les nouvelles exceptions apparaîtront ici dès leur premier envoi.</p>
              </div>
            }
          </section>
        </div>
      } @else if (error()) {
        <div class="panel empty danger">
          <p>{{ error() }}</p>
          <button class="btn" (click)="reload()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button>
        </div>
      } @else {
        <div class="stats panel" aria-busy="true">
          @for (g of [1, 2, 3, 4, 5]; track g) {
            <div class="tile ghost"><i class="skeleton" style="width: 55%; height: 10px"></i><i class="skeleton" style="width: 45%; height: 20px"></i><i class="skeleton" style="width: 65%; height: 9px"></i></div>
          }
        </div>
        <section class="panel" aria-busy="true">
          <div class="panel-head"><i class="skeleton" style="width: 140px; height: 12px"></i></div>
          <div class="panel-body"><i class="skeleton" style="height: 180px"></i></div>
        </section>
        <div class="cols" aria-busy="true">
          @for (g of [1, 2]; track g) {
            <section class="panel ghost-list">
              <div class="panel-head"><i class="skeleton" style="width: 120px; height: 12px"></i></div>
              @for (r of [92, 74, 86, 61, 80]; track $index) { <div class="ghost-row"><i class="skeleton ghost-avatar"></i><i class="skeleton" [style.width.%]="r - 20" style="height: 10px"></i></div> }
            </section>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .period { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; color: var(--text-2);
      background: var(--surface-2); border: 1px solid var(--border-soft); }
    .period wl-nav-icon { color: var(--accent); }
    /* En ce moment */
    .now { display: flex; flex-wrap: wrap; align-items: stretch; overflow: hidden; }
    .now.calm { align-items: center; gap: 10px; padding: 10px 16px; color: var(--text-2); }
    .ok-icon { flex: none; color: var(--ok); }
    .now-item { position: relative; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-right: 1px solid var(--border);
      color: var(--text-1); min-width: 0; max-width: 440px; transition: background-color .2s;
      animation: now-in .45s var(--ease) backwards; animation-delay: calc(var(--i) * 60ms + 120ms); }
    @keyframes now-in { from { opacity: 0; transform: translateX(-8px); } }
    .now-item:hover { background: var(--row-hover); text-decoration: none; }
    .now-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 10px; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 15%, transparent); transition: transform .4s var(--spring); }
    .now-item:hover .now-icon { transform: rotate(-8deg) scale(1.1); }
    .now-item.critical { --tone: var(--danger); }
    .now-item.warning { --tone: var(--warn); }
    .now-text { display: grid; gap: 1px; min-width: 0; }
    .now-item strong { font-size: 15px; margin-right: 2px; color: var(--tone); font-variant-numeric: tabular-nums; }
    .now-item .go { color: var(--tone); opacity: 0; transform: translateX(-6px); transition: opacity .2s, transform .35s var(--spring); }
    .now-item:hover .go { opacity: 1; transform: none; }
    /* Chiffres clés */
    .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); overflow: hidden; }
    .tile { position: relative; display: grid; gap: 3px; padding: 12px 16px 14px; border-right: 1px solid var(--border); color: inherit; transition: background-color .2s; }
    .tile:last-child { border-right: 0; }
    /* Liseré d'accent qui se déploie sous la case survolée. */
    .tile::after { content: ''; position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0;
      background: linear-gradient(90deg, var(--accent), var(--accent-2)); transform: scaleX(0); transition: transform .4s var(--spring); }
    a.tile:hover { background: var(--row-hover); text-decoration: none; }
    a.tile:hover::after { transform: scaleX(1); }
    .tile .label { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
    .tile .label wl-nav-icon { color: var(--accent); opacity: .85; transition: transform .4s var(--spring); }
    a.tile:hover .label wl-nav-icon { transform: scale(1.18) rotate(-8deg); }
    .tile.alert .label wl-nav-icon { color: var(--danger); }
    .tile.crashed .label wl-nav-icon { color: var(--crash); }
    .tile strong { font-size: 22px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .tile strong.crash { color: var(--crash); }
    .tile em { font-style: normal; font-size: 11.5px; color: var(--text-3); }
    /* Flèche dans une marge réservée à droite de la tuile : elle ne recouvre jamais le libellé. */
    a.tile { padding-right: 34px; }
    .tile .go { position: absolute; top: 12px; right: 12px; color: var(--accent); opacity: 0; transform: translateX(-6px); transition: opacity .2s, transform .35s var(--spring); }
    a.tile:hover .go { opacity: 1; transform: none; }
    .tile.ghost { gap: 8px; }
    /* En-têtes de panneaux */
    .with-icon { display: inline-flex; align-items: center; gap: 8px; }
    .with-icon wl-nav-icon { color: var(--accent); }
    .hint { display: inline-flex; align-items: center; gap: 6px; }
    .count { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
      font: 650 11px var(--mono); color: var(--accent); background: var(--accent-soft); }
    .count.danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .more { display: inline-flex; align-items: center; gap: 5px; }
    .more wl-nav-icon { transition: transform .35s var(--spring); }
    .more:hover wl-nav-icon { transform: translateX(3px); }
    /* Tableau des services */
    .svc-cell { max-width: 0; width: 26%; }
    .svc { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .avatar { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 50%; color: #fff; font: 700 9.5px/1 var(--sans);
      letter-spacing: .02em; background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%));
      box-shadow: 0 4px 10px -4px hsl(var(--hue) 70% 45% / .9), inset 0 1px 0 rgb(255 255 255 / .35); transition: transform .4s var(--spring); }
    tr.click:hover .avatar { transform: scale(1.12) rotate(-6deg); }
    /* Nombre d'erreurs du service : petite étiquette rouge, chiffres alignés. */
    .err-chip { display: inline-block; min-width: 26px; padding: 0 7px; border-radius: 999px; font-weight: 600; line-height: 20px; text-align: center;
      font-variant-numeric: tabular-nums; color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .seen { display: inline-flex; align-items: center; gap: 7px; }
    .seen.live { color: var(--ok); }
    .exc { max-width: 0; width: 70%; }
    .count-cell { font-weight: 600; }
    .version { display: inline-block; max-width: 90px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; margin-right: 8px;
      padding: 0 6px; border-radius: 6px; background: var(--surface-3); }
    .empty p { margin: 0 auto 8px; max-width: 420px; }
    .empty .btn { margin-top: 4px; }
    .ghost-list { padding-bottom: 8px; }
    .ghost-row { display: flex; align-items: center; gap: 10px; padding: 10px 16px; }
    .ghost-avatar { width: 22px; height: 22px; border-radius: 50%; flex: none; }
    @media (max-width: 900px) { .stats { grid-template-columns: repeat(2, 1fr); } .tile { border-bottom: 1px solid var(--border); } }
  `,
})
export class OverviewPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);
  private readonly session = inject(Session);
  protected readonly data = signal<Overview | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  private sub?: Subscription;
  private readonly deployments = inject(Deployments);
  /** Dernier déploiement de chaque service sur la période. */
  protected readonly lastDeploy = computed(() => {
    const map = new Map<string, Deployment>();
    for (const d of this.deployments.list()) if (!map.has(d.service)) map.set(d.service, d);
    return map;
  });

  protected readonly times = computed(() => this.data()?.logHistogram.buckets.map((b) => b.t) ?? []);
  protected readonly series = computed<ChartSeries[]>(() => {
    const buckets = this.data()?.logHistogram.buckets ?? [];
    return LEVELS.map((l) => ({ label: l, color: LEVEL_COLORS[l], values: buckets.map((b) => b[l]) }));
  });
  protected readonly errorRate = computed(() => {
    const d = this.data();
    if (!d || !d.logs) return '0 % des logs';
    return ((d.errors / d.logs) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' % des logs';
  });

  /** Alertes actives, sondes en panne, objectifs non tenus, santé de Wolflog. */
  protected readonly attention = signal<{ items: AttentionItem[]; summary: string } | null>(null);

  constructor() {
    effect(() => {
      this.state.range();
      this.state.tick();
      untracked(() => {
        this.load();
        this.loadAttention();
      });
    });
  }

  private loadAttention() {
    forkJoin({
      // Seulement les parties ouvertes par le profil d'accès (les autres seraient refusées).
      alerts: this.session.can('alerts') ? this.api.activeAlerts().pipe(catchError(() => of(null))) : of(null),
      probes: this.session.can(['uptime', 'alerts', 'slos']) ? this.api.probes({ from: '1h', to: '' }, 1).pipe(catchError(() => of(null))) : of(null),
      slos: this.session.can(['slos', 'alerts']) ? this.api.slos().pipe(catchError(() => of(null))) : of(null),
      health: this.api.wolflogHealth().pipe(catchError(() => of(null))),
    }).subscribe(({ alerts, probes, slos, health }) => {
      const items: AttentionItem[] = [];
      const firing = alerts?.items.filter((a) => a.status === 'firing') ?? [];
      if (firing.length) {
        const critical = firing.some((a) => a.severity === 'critical');
        items.push({ count: firing.length, label: firing.length > 1 ? 'alertes en cours' : 'alerte en cours', level: critical ? 'critical' : 'warning', icon: 'alerts',
          link: '/alerts', query: { tab: 'active' }, detail: firing[0].message ?? firing[0].ruleName });
      }
      const down = probes?.filter((p) => p.status === 'down') ?? [];
      if (down.length) items.push({ count: down.length, label: down.length > 1 ? 'sondes en panne' : 'sonde en panne', level: 'critical', icon: 'uptime', link: '/uptime',
        detail: down.map((p) => p.probe.name).join(', ') });
      const breached = slos?.filter((x) => x.status.state === 'breached') ?? [];
      const atRisk = slos?.filter((x) => x.status.state === 'warning') ?? [];
      if (breached.length) items.push({ count: breached.length, label: breached.length > 1 ? 'objectifs non tenus' : 'objectif non tenu', level: 'critical', icon: 'slos', link: '/slos',
        detail: breached.map((x) => x.slo.name).join(', ') });
      if (atRisk.length) items.push({ count: atRisk.length, label: 'objectif(s) à surveiller', level: 'warning', icon: 'target', link: '/slos', detail: atRisk.map((x) => x.slo.name).join(', ') });
      const problems = health?.checks.filter((c) => c.status !== 'ok') ?? [];
      if (problems.length) items.push({ count: problems.length, label: 'point(s) de santé de Wolflog', level: health!.status === 'critical' ? 'critical' : 'warning', icon: 'system',
        link: this.session.isAdmin() ? '/system' : '/', detail: problems.map((c) => `${c.name} : ${c.message}`).join(' · ') });

      const summary = [
        alerts ? 'aucune alerte' : '',
        probes?.length ? `${probes.filter((p) => p.status === 'up').length} sonde(s) en ligne` : '',
        slos?.length ? `${slos.length} objectif(s) tenu(s)` : '',
      ].filter(Boolean).join(', ');
      this.attention.set({ items, summary });
    });
  }

  private load() {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.sub = this.api.overview(this.state.range()).subscribe({
      next: (d) => {
        this.data.set(d);
        this.error.set('');
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Impossible de charger les données.');
      },
    });
  }

  protected reload() {
    this.error.set('');
    this.load();
    this.loadAttention();
  }

  protected hueOf(name: string) {
    return hue(name);
  }

  protected initialsOf(name: string) {
    return initials(name);
  }

  /** Données reçues il y a moins de 5 minutes : pastille « en direct ». */
  protected fresh(lastSeen: string | null | undefined) {
    const t = lastSeen ? Date.parse(lastSeen) : NaN;
    return Number.isFinite(t) && Date.now() - t < 5 * 60_000;
  }

  zoom(r: { from: Date; to: Date }) {
    this.state.setAbsolute(r.from, r.to);
  }

  openService(name: string) {
    this.state.setService(name);
    this.router.navigate(['/logs']);
  }
}
