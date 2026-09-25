import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api, Overview } from '../core/api';
import { AppState, Deployments, Session } from '../core/state';
import { catchError, forkJoin, of } from 'rxjs';
import { Deployment } from '../core/api';
import { ErrorStatusTag } from '../shared/widgets';
import { AgoPipe, DurPipe, LEVEL_COLORS, LEVELS, NumPipe } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';

@Component({
  selector: 'vg-overview',
  imports: [Chart, NumPipe, DurPipe, AgoPipe, RouterLink, ErrorStatusTag],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head"><h1>Vue d'ensemble</h1></div>

      <!-- En ce moment : ce qui demande de l'attention, sans avoir à ouvrir chaque page. -->
      @if (attention(); as a) {
        <div class="now panel" [class.calm]="!a.items.length">
          @if (a.items.length) {
            @for (i of a.items; track i.label) {
              <a class="now-item" [class]="i.level" [routerLink]="i.link" [queryParams]="i.query ?? {}" [title]="i.detail ?? ''">
                <strong>{{ i.count }}</strong> {{ i.label }}
                @if (i.detail) { <span class="muted small ellipsis">{{ i.detail }}</span> }
              </a>
            }
          } @else {
            <span class="ok-dot"></span>
            <span>Tout va bien{{ a.summary ? ' : ' + a.summary : '' }}.</span>
          }
        </div>
      }

      @if (data(); as d) {
        <div class="stats panel">
          <a routerLink="/logs"><span>Logs</span><strong>{{ d.logs | num }}</strong></a>
          <a routerLink="/logs" [queryParams]="{ level: 'error' }">
            <span>Erreurs</span><strong [class.danger]="d.errors > 0">{{ d.errors | num }}</strong><em>{{ errorRate() }}</em>
          </a>
          <a routerLink="/errors" [queryParams]="{ q: 'crash:true' }"><span>Crashs</span><strong [class.crash]="d.crashes > 0">{{ d.crashes | num }}</strong></a>
          <a routerLink="/traces"><span>Traces</span><strong>{{ d.traces | num }}</strong><em>{{ d.spans | num }} spans</em></a>
          <div><span>Latence p95</span><strong>{{ d.p95Ms | dur }}</strong><em>requêtes entrantes</em></div>
        </div>

        <section class="panel">
          <div class="panel-head"><h2>Logs par niveau</h2><span class="muted small">glisser pour zoomer</span></div>
          <div class="panel-body">
            <vg-chart [times]="times()" [series]="series()" kind="bars" [stacked]="true" [height]="180" (rangeSelect)="zoom($event)" />
          </div>
        </section>

        <div class="cols">
          <section class="panel">
            <div class="panel-head"><h2>Services</h2></div>
            @if (d.services.length) {
              <table class="list">
                <thead><tr><th>Nom</th><th class="r">Logs</th><th class="r">Erreurs</th><th class="r">Spans</th><th class="r">p95</th><th>Dernier déploiement</th><th>Dernier envoi</th></tr></thead>
                <tbody>
                  @for (s of d.services; track s.name) {
                    <tr class="click" (click)="openService(s.name)">
                      <td>{{ s.name }}</td>
                      <td class="r">{{ s.logs | num }}</td>
                      <td class="r" [class.danger]="s.errors > 0">{{ s.errors | num }}</td>
                      <td class="r">{{ s.spans | num }}</td>
                      <td class="r">{{ s.p95Ms | dur }}</td>
                      <td class="small nowrap">
                        @if (lastDeploy().get(s.name); as dep) {
                          <span class="mono version" [title]="dep.version">{{ dep.version }}</span><span class="muted">{{ dep.at | ago }}</span>
                        }
                      </td>
                      <td class="muted">{{ s.lastSeen | ago }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="empty">Aucune donnée reçue sur cette période. <a routerLink="/admin/keys/new">Connecter une application</a></div>
            }
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Erreurs à traiter</h2><span class="spacer"></span><a routerLink="/errors" class="small">Tout voir</a></div>
            @if (d.topErrors.length) {
              <table class="list">
                <thead><tr><th>Exception</th><th class="r">Nombre</th><th>Dernière</th></tr></thead>
                <tbody>
                  @for (e of d.topErrors; track e.fingerprint) {
                    <tr class="click" [routerLink]="['/errors', e.fingerprint]">
                      <td class="exc">
                        <div class="ellipsis">@if (e.crashes) { <span class="tag crash">crash</span> } <vg-error-status [status]="e.status" /> <span class="mono">{{ e.exceptionType }}</span></div>
                        <div class="muted small ellipsis">{{ e.message }}</div>
                      </td>
                      <td class="r">{{ e.count | num }}</td>
                      <td class="muted nowrap">{{ e.lastSeen | ago }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="empty">Aucune erreur à traiter sur cette période.</div>
            }
          </section>
        </div>
      } @else if (error()) {
        <div class="panel empty danger">{{ error() }}</div>
      }
    </div>
  `,
  styles: `
    .now { display: flex; flex-wrap: wrap; align-items: stretch; }
    .now.calm { align-items: center; gap: 8px; padding: 9px 14px; color: var(--text-2); }
    .ok-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
    .now-item { display: grid; gap: 2px; padding: 9px 14px; border-right: 1px solid var(--border); color: var(--text-1); min-width: 0; max-width: 420px; }
    .now-item:hover { background: var(--row-hover); text-decoration: none; }
    .now-item strong { font-size: 15px; margin-right: 4px; }
    .now-item.critical strong { color: var(--danger); }
    .now-item.warning strong { color: var(--warn); }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .stats > * { display: grid; gap: 2px; padding: 10px 14px; border-right: 1px solid var(--border); color: inherit; }
    .stats > *:last-child { border-right: 0; }
    .stats a:hover { background: var(--row-hover); text-decoration: none; }
    .stats span { font-size: 11.5px; color: var(--text-3); }
    .stats strong { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .stats strong.crash { color: var(--crash); }
    .stats em { font-style: normal; font-size: 11.5px; color: var(--text-3); }
    .exc { max-width: 0; width: 70%; }
    .version { display: inline-block; max-width: 90px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; margin-right: 8px; }
    @media (max-width: 900px) { .stats { grid-template-columns: repeat(2, 1fr); } .stats > * { border-bottom: 1px solid var(--border); } }
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

  /** Alertes actives, sondes en panne, objectifs non tenus, santé de Vigil. */
  protected readonly attention = signal<{
    items: { count: number; label: string; level: string; link: string; query?: Record<string, string>; detail?: string }[];
    summary: string;
  } | null>(null);

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
      alerts: this.api.activeAlerts().pipe(catchError(() => of(null))),
      probes: this.api.probes({ from: '1h', to: '' }, 1).pipe(catchError(() => of(null))),
      slos: this.api.slos().pipe(catchError(() => of(null))),
      health: this.api.vigilHealth().pipe(catchError(() => of(null))),
    }).subscribe(({ alerts, probes, slos, health }) => {
      const items: { count: number; label: string; level: string; link: string; query?: Record<string, string>; detail?: string }[] = [];
      const firing = alerts?.items.filter((a) => a.status === 'firing') ?? [];
      if (firing.length) {
        const critical = firing.some((a) => a.severity === 'critical');
        items.push({ count: firing.length, label: firing.length > 1 ? 'alertes en cours' : 'alerte en cours', level: critical ? 'critical' : 'warning',
          link: '/alerts', query: { tab: 'active' }, detail: firing[0].message ?? firing[0].ruleName });
      }
      const down = probes?.filter((p) => p.status === 'down') ?? [];
      if (down.length) items.push({ count: down.length, label: down.length > 1 ? 'sondes en panne' : 'sonde en panne', level: 'critical', link: '/uptime',
        detail: down.map((p) => p.probe.name).join(', ') });
      const breached = slos?.filter((x) => x.status.state === 'breached') ?? [];
      const atRisk = slos?.filter((x) => x.status.state === 'warning') ?? [];
      if (breached.length) items.push({ count: breached.length, label: breached.length > 1 ? 'objectifs non tenus' : 'objectif non tenu', level: 'critical', link: '/slos',
        detail: breached.map((x) => x.slo.name).join(', ') });
      if (atRisk.length) items.push({ count: atRisk.length, label: 'objectif(s) à surveiller', level: 'warning', link: '/slos', detail: atRisk.map((x) => x.slo.name).join(', ') });
      const problems = health?.checks.filter((c) => c.status !== 'ok') ?? [];
      if (problems.length) items.push({ count: problems.length, label: 'point(s) de santé de Vigil', level: health!.status === 'critical' ? 'critical' : 'warning',
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
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Impossible de charger les données.');
      },
    });
  }

  zoom(r: { from: Date; to: Date }) {
    this.state.setAbsolute(r.from, r.to);
  }

  openService(name: string) {
    this.state.setService(name);
    this.router.navigate(['/logs']);
  }
}
