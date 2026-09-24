import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ErrorDetail, Person } from '../core/api';
import { AppState, Session } from '../core/state';
import { AgoPipe, NumPipe, TimePipe, parseJson } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';
import { Attributes, ErrorStatusTag } from '../shared/widgets';

@Component({
  selector: 'vg-error-detail',
  imports: [RouterLink, Chart, Attributes, ErrorStatusTag, NumPipe, AgoPipe, TimePipe],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <a routerLink="/errors" class="small">Erreurs</a>
        <span class="muted">/</span>
        @if (detail(); as d) {
          <h1 class="mono ellipsis">{{ d.group.exceptionType }}</h1>
          @if (d.group.crashes) { <span class="tag crash">crash</span> }
          <vg-error-status [status]="d.group.status" />
          <span class="spacer"></span>
          <a class="btn" routerLink="/logs" [queryParams]="{ q: 'fingerprint:' + d.group.fingerprint }">Logs</a>
          @if (d.latest?.traceId) {
            <a class="btn" [routerLink]="['/traces', d.latest!.traceId]" [queryParams]="{ around: d.latest!.ts }">Dernière trace</a>
          }
        }
      </div>

      @if (detail(); as d) {
        <div class="panel triage">
          <div class="field">
            <span>Statut</span>
            @if (session.canEdit()) {
              <div class="seg">
                <button [class.on]="d.group.status === 'open' || d.group.status === 'regressed'" (click)="setStatus('open')">À traiter</button>
                <button [class.on]="d.group.status === 'resolved'" (click)="setStatus('resolved')" title="Si l'erreur se reproduit, elle repassera « réapparue »">Résolue</button>
                <button [class.on]="d.group.status === 'ignored'" (click)="setStatus('ignored')" title="Masquée de la vue d'ensemble et de la liste à traiter">Ignorée</button>
              </div>
            } @else {
              <strong>{{ statusLabel(d.group.status) }}</strong>
            }
          </div>
          <div class="field">
            <span>Assignée à</span>
            @if (session.canEdit()) {
              <select [value]="d.group.assignedTo ?? ''" (change)="assign($any($event.target).value)">
                <option value="">Personne</option>
                @if (session.me()?.user; as me) { <option [value]="me">Moi</option> }
                @for (p of people(); track p.username) {
                  @if (p.username !== session.me()?.user) { <option [value]="p.username">{{ p.displayName }}</option> }
                }
              </select>
            } @else {
              <strong>{{ personName(d.group.assignedTo) || 'Personne' }}</strong>
            }
          </div>
          <div class="field note">
            <span>Note</span>
            @if (session.canEdit()) {
              <input [value]="d.state?.note ?? ''" (change)="saveNote($any($event.target).value)" (keydown.enter)="$any($event.target).blur()"
                     placeholder="Cause, ticket, correctif prévu… (Entrée pour enregistrer)" />
            } @else {
              <strong>{{ d.state?.note || '–' }}</strong>
            }
          </div>
          @if (d.state?.history?.length) {
            <div class="field history" [title]="historyText()">
              <span>Dernière action</span>
              <strong class="small">{{ personName(d.state!.history[0].by) || 'Quelqu’un' }} {{ d.state!.history[0].action }}, {{ d.state!.history[0].at | ago }}</strong>
            </div>
          }
        </div>

        <div class="panel facts">
          <div class="msg mono">{{ d.group.message }}</div>
          <div><span>Occurrences</span><strong>{{ d.group.count | num }}</strong></div>
          <div><span>Dont crashs</span><strong [class.crash]="d.group.crashes">{{ d.group.crashes | num }}</strong></div>
          <div><span>Première</span><strong>{{ d.group.firstSeen | ago }}</strong></div>
          <div><span>Dernière</span><strong>{{ d.group.lastSeen | ago }}</strong></div>
          <div><span>Service</span><strong>{{ d.group.service }}{{ d.group.services > 1 ? ' +' + (d.group.services - 1) : '' }}</strong></div>
          @if (versions().length) {
            <div><span>Versions touchées</span><strong class="mono small">{{ versions().join(', ') }}</strong></div>
          }
        </div>

        <section class="panel">
          <div class="panel-head"><h2>Occurrences dans le temps</h2></div>
          <div class="panel-body">
            <vg-chart [times]="times()" [series]="series()" kind="bars" [height]="100" [legend]="false" (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
          </div>
        </section>

        @if (d.latest; as l) {
          <div class="cols">
            <section class="panel">
              <div class="panel-head"><h2>Pile d'appels</h2><span class="muted small">dernière occurrence, {{ l.ts | time: true }}</span></div>
              <div class="panel-body">
                @if (l.exceptionStack) {
                  <pre class="stack">{{ l.exceptionStack }}</pre>
                } @else {
                  <p class="muted small">Pas de pile d'appels : le processus s'est arrêté sans passer par un gestionnaire d'exception.
                    Les logs émis juste avant l'arrêt sont listés à côté.</p>
                }
              </div>
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Contexte</h2></div>
              <div class="panel-body stack-y">
                <table class="ctx">
                  <tr><td>Hôte</td><td>{{ l.host ?? '–' }}</td></tr>
                  <tr><td>Version</td><td>{{ l.version ?? '–' }}</td></tr>
                  <tr><td>Environnement</td><td>{{ l.env ?? '–' }}</td></tr>
                  <tr><td>Catégorie</td><td class="mono">{{ l.category ?? '–' }}</td></tr>
                  <tr><td>Message</td><td class="mono">{{ l.body }}</td></tr>
                </table>
                @if (breadcrumbs().length) {
                  <h3>Logs précédant le crash</h3>
                  <div class="crumbs mono">
                    @for (c of breadcrumbs(); track $index) {
                      <div><span class="muted">{{ c.Ts | time }}</span> {{ c.Level }} {{ c.Message }}</div>
                    }
                  </div>
                }
                <h3>Attributs</h3>
                <vg-attributes [json]="l.attributes" [exclude]="['vigil.breadcrumbs']" />
              </div>
            </section>
          </div>
        }

        <section class="panel">
          <div class="panel-head"><h2>Occurrences récentes</h2></div>
          <table class="list">
            <thead><tr><th>Date</th><th>Service</th><th>Hôte</th><th>Version</th><th>Message</th><th></th></tr></thead>
            <tbody>
              @for (o of d.occurrences; track $index) {
                <tr>
                  <td class="mono small nowrap">{{ o.ts | time: true }}</td>
                  <td class="nowrap">{{ o.service }}</td>
                  <td class="nowrap">{{ o.host ?? '–' }}</td>
                  <td class="nowrap">{{ o.version ?? '–' }}</td>
                  <td class="m ellipsis">@if (o.isCrash) { <span class="tag crash">crash</span> } {{ o.message }}</td>
                  <td class="nowrap">@if (o.traceId) { <a [routerLink]="['/traces', o.traceId]" [queryParams]="{ around: o.ts }">trace</a> }</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      } @else if (!loading()) {
        <div class="panel empty">Aucune occurrence de cette erreur sur la période choisie.</div>
      }
    </div>
  `,
  styles: `
    .triage { display: flex; flex-wrap: wrap; align-items: stretch; }
    .triage .field { display: grid; gap: 4px; align-content: start; padding: 8px 16px; border-right: 1px solid var(--border); }
    .triage .field:last-child { border-right: 0; }
    .triage .field > span { font-size: 11.5px; color: var(--text-3); }
    .triage .note { flex: 1; min-width: 220px; }
    .triage .note input { width: 100%; }
    .triage .history { max-width: 340px; }
    .triage select { min-width: 160px; }
    vg-error-status { margin-left: 2px; }
    .facts { display: flex; flex-wrap: wrap; }
    .facts > div { display: grid; gap: 2px; padding: 8px 16px; border-right: 1px solid var(--border); }
    .facts > div:last-child { border-right: 0; }
    .facts span { font-size: 11.5px; color: var(--text-3); }
    .facts strong { font-weight: 600; }
    .facts strong.crash { color: var(--crash); }
    .facts .msg { flex: 1 1 100%; border-right: 0; border-bottom: 1px solid var(--border); padding: 10px 16px; color: var(--text-2); font-size: 12.5px; }
    .stack-y > * + * { margin-top: 8px; }
    .ctx { font-size: 12px; border-collapse: collapse; width: 100%; table-layout: fixed; }
    .ctx td { overflow-wrap: anywhere; }
    .ctx td:first-child { width: 110px; }
    .ctx td { padding: 2px 16px 2px 0; vertical-align: top; }
    .ctx td:first-child { color: var(--text-3); white-space: nowrap; }
    h3 { margin-top: 8px; }
    .crumbs { font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; max-height: 260px; overflow: auto; }
    .m { max-width: 0; width: 45%; }
    p { margin: 0; }
    .tag { margin-right: 6px; }
  `,
})
export class ErrorDetailPage {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);
  readonly fingerprint = input.required<string>();
  protected readonly detail = signal<ErrorDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly session = inject(Session);
  protected readonly people = signal<Person[]>([]);

  protected readonly versions = computed(() => {
    const seen: string[] = [];
    for (const o of [...(this.detail()?.occurrences ?? [])].reverse()) if (o.version && !seen.includes(o.version)) seen.push(o.version);
    return seen;
  });
  protected readonly historyText = computed(() =>
    (this.detail()?.state?.history ?? []).map((h) => `${new Date(h.at).toLocaleString('fr-FR')} : ${this.personName(h.by) || '?'} ${h.action}`).join(String.fromCharCode(10)));

  protected statusLabel(s: string) {
    return ({ open: 'À traiter', regressed: 'Réapparue', resolved: 'Résolue', ignored: 'Ignorée' } as Record<string, string>)[s] ?? s;
  }

  protected personName(username: string | null | undefined) {
    if (!username) return '';
    return this.people().find((p) => p.username === username)?.displayName ?? username;
  }

  protected setStatus(status: string) {
    this.change({ status });
  }

  protected assign(username: string) {
    this.change(username ? { assignedTo: username } : { unassign: true });
  }

  protected saveNote(note: string) {
    this.change({ note });
  }

  private change(c: { status?: string; assignedTo?: string; unassign?: boolean; note?: string }) {
    const d = this.detail();
    if (!d) return;
    this.api.setErrorState(d.group.fingerprint, c).subscribe(() => this.reload());
  }

  protected readonly times = computed(() => this.detail()?.histogram.buckets.map((b) => b.t) ?? []);
  protected readonly series = computed<ChartSeries[]>(() => {
    const b = this.detail()?.histogram.buckets ?? [];
    return [{ label: 'occurrences', color: '#d45f5f', values: b.map((x) => x.trace + x.debug + x.info + x.warn + x.error + x.fatal) }];
  });
  protected readonly breadcrumbs = computed<{ Ts: string; Level: string; Message: string }[]>(() => {
    const raw = parseJson(this.detail()?.latest?.attributes)['vigil.breadcrumbs'];
    if (typeof raw !== 'string') return [];
    try { return JSON.parse(raw); } catch { return []; }
  });

  constructor() {
    this.api.people().subscribe({ next: (p) => this.people.set(p), error: () => {} });
    effect(() => {
      this.fingerprint();
      this.state.range();
      this.state.tick();
      untracked(() => this.reload());
    });
  }

  private reload() {
    this.loading.set(true);
    this.api.error(this.fingerprint(), this.state.range()).subscribe({
      next: (d) => {
        this.detail.set(d);
        this.loading.set(false);
      },
      error: () => {
        this.detail.set(null);
        this.loading.set(false);
      },
    });
  }
}
