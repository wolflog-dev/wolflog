import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { ProfileInfo, ProfilingInstance } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { CodeBlock } from '../shared/code-block';
import { FlameGraph, FlameNode, buildTree, shortName } from '../shared/flamegraph';

@Component({
  selector: 'wl-profiles',
  imports: [FormsModule, AgoPipe, TimePipe, CodeBlock, FlameGraph],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Profils</h1>
        <span class="muted small">où l'application passe son temps (CPU) et ce qu'elle alloue (mémoire), à la demande</span>
        <span class="spacer"></span>
        @if (session.canEdit()) {
          <select [ngModel]="service()" (ngModelChange)="service.set($event)" aria-label="Service à profiler">
            @for (s of services(); track s) { <option [value]="s">{{ s }} ({{ countFor(s) }})</option> }
            @if (!services().length) { <option value="">aucune application prête</option> }
          </select>
          <div class="seg">
            <button [class.on]="kind() === 'cpu'" (click)="kind.set('cpu')">CPU</button>
            <button [class.on]="kind() === 'alloc'" (click)="kind.set('alloc')">Mémoire</button>
          </div>
          <select [ngModel]="seconds()" (ngModelChange)="seconds.set(+$event)" aria-label="Durée">
            <option [value]="15">15 s</option><option [value]="30">30 s</option><option [value]="60">60 s</option>
          </select>
          <button class="btn primary" (click)="request()" [disabled]="!service() || running()">{{ running() ? 'Profil en cours…' : 'Profiler maintenant' }}</button>
        }
      </div>

      @if (!instances().length) {
        <section class="panel setup">
          <div class="panel-head"><h2>Activer le profilage dans une application .NET</h2></div>
          <div class="panel-body">
            <wl-code [code]="setup" />
            <p class="muted small">Aucun coût tant qu'aucun profil n'est demandé : l'application interroge Wolflog toutes les 10 secondes.
              Pendant un profil, l'échantillonnage (EventPipe, comme dotnet-trace) ralentit l'application de quelques pour cent.</p>
          </div>
        </section>
      }

      <div class="layout">
        <section class="panel list">
          <div class="panel-head"><h2>Historique</h2></div>
          @for (p of profiles(); track p.id) {
            <button class="item" [class.on]="p.id === selectedId()" (click)="open(p)" [disabled]="p.status === 'pending' || p.status === 'running'">
              <span class="row1">
                <span class="kind">{{ p.kind === 'alloc' ? 'Mémoire' : 'CPU' }}</span>
                <span class="ellipsis">{{ p.service }}</span>
                <span class="spacer"></span>
                <span class="muted small nowrap">{{ p.requestedAt | ago }}</span>
              </span>
              <span class="row2 small">
                @switch (p.status) {
                  @case ('pending') { <span class="warn">en attente de l'application…</span> }
                  @case ('running') { <span class="warn">enregistrement ({{ p.seconds }} s)…</span> }
                  @case ('failed') { <span class="danger ellipsis" [title]="p.error ?? ''">{{ p.error }}</span> }
                  @default { <span class="muted">{{ p.host ?? '' }} · {{ round(p.seconds) }} s · {{ describeTotal(p) }}</span> }
                }
              </span>
            </button>
          } @empty {
            <div class="empty small">Aucun profil.</div>
          }
        </section>

        <section class="panel viewer">
          @if (tree(); as t) {
            <div class="panel-head">
              <h2>{{ selected()?.kind === 'alloc' ? 'Allocations' : 'Temps CPU' }} de {{ selected()?.service }}</h2>
              <span class="muted small">{{ selected()?.start | time: true }} · {{ selected()?.host }} {{ selected()?.version ? '· v' + selected()?.version : '' }}</span>
            </div>
            <div class="panel-body">
              <wl-flamegraph #fg [root]="t" [kind]="selected()?.kind === 'alloc' ? 'alloc' : 'cpu'" />
              <h3>{{ selected()?.kind === 'alloc' ? 'Méthodes qui allouent le plus' : 'Méthodes les plus coûteuses' }} (temps propre)</h3>
              <table class="list">
                <tbody>
                  @for (m of topSelf(); track m.name) {
                    <tr class="click" (click)="fg.search.set(shortOf(m.name))" [title]="m.name">
                      <td class="mono small ellipsis name">{{ m.name }}</td>
                      <td class="r mono small nowrap">{{ pct(m.self) }}</td>
                      <td class="bar-cell"><span class="barline" [style.width.%]="(100 * m.self) / (topSelf()[0]?.self || 1)"></span></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="empty">
              @if (running()) { Enregistrement en cours : le profil s'affichera ici automatiquement. }
              @else { Choisissez un profil, ou lancez-en un avec « Profiler maintenant ». }
            </div>
          }
        </section>
      </div>
    </div>
  `,
  styles: `
    .layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; align-items: start; }
    .list { max-height: calc(100vh - 140px); overflow: auto; }
    .item { display: grid; gap: 2px; width: 100%; padding: 8px 12px; border: 0; border-bottom: 1px solid var(--border-soft); background: none;
      color: var(--text-1); font: 13px var(--sans); text-align: left; cursor: pointer; }
    .item:hover:not(:disabled) { background: var(--row-hover); }
    .item.on { background: var(--row-selected); box-shadow: inset 2px 0 0 var(--accent); }
    .item:disabled { cursor: default; }
    .row1 { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
    .row2 { display: flex; min-width: 0; }
    .kind { font: 600 11px var(--mono); text-transform: uppercase; color: var(--text-3); }
    .warn { color: var(--warn); }
    h3 { margin: 14px 0 6px; }
    .name { max-width: 0; width: 70%; }
    .bar-cell { width: 25%; }
    .barline { display: block; height: 6px; background: var(--accent); opacity: .6; border-radius: 3px; }
    .setup p { margin: 8px 0 0; }
    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }
  `,
})
export class ProfilesPage {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  protected readonly session = inject(Session);
  readonly id = input<string>('');

  protected readonly instances = signal<ProfilingInstance[]>([]);
  protected readonly profiles = signal<ProfileInfo[]>([]);
  protected readonly service = signal('');
  protected readonly kind = signal<'cpu' | 'alloc'>('cpu');
  protected readonly seconds = signal(30);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly tree = signal<FlameNode | null>(null);
  private readonly waitingFor = signal<string | null>(null);

  protected readonly setup =
    'dotnet add package Wolflog.Client.Profiling\n\n// Program.cs, après builder.AddWolflog();\nbuilder.AddWolflogProfiling();';

  protected readonly services = computed(() => [...new Set(this.instances().map((i) => i.service))].sort());
  protected readonly running = computed(() => this.profiles().some((p) => p.status === 'pending' || p.status === 'running'));
  protected readonly selected = computed(() => this.profiles().find((p) => p.id === this.selectedId()) ?? null);
  protected readonly topSelf = computed(() => {
    const t = this.tree();
    if (!t) return [];
    const self = new Map<string, number>();
    const walk = (n: FlameNode) => { if (n.self) self.set(n.name, (self.get(n.name) ?? 0) + n.self); n.children.forEach(walk); };
    walk(t);
    return [...self.entries()].map(([name, v]) => ({ name, self: v })).sort((a, b) => b.self - a.self).slice(0, 15);
  });

  constructor() {
    this.load();
    const timer = setInterval(() => this.load(), 3000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      const id = this.id();
      untracked(() => { if (id) this.openById(id); });
    });
  }

  private load() {
    this.api.profilingInstances().subscribe((i) => {
      this.instances.set(i);
      const current = this.service();
      if (!current || !this.services().includes(current)) {
        const preferred = this.state.service();
        this.service.set(this.services().includes(preferred) ? preferred : (this.services()[0] ?? ''));
      }
    });
    this.api.profiles().subscribe((list) => {
      this.profiles.set(list);
      // Profil demandé depuis cette page : ouvert dès qu'il arrive.
      const waiting = this.waitingFor();
      const done = waiting ? list.find((p) => p.id === waiting && p.status !== 'pending' && p.status !== 'running') : null;
      if (done) {
        this.waitingFor.set(null);
        if (done.status === 'done') this.open(done);
      } else if (!this.selectedId() && !waiting) {
        const latest = list.find((p) => p.status === 'done');
        if (latest) this.open(latest);
      }
    });
  }

  protected countFor(service: string) {
    const n = this.instances().filter((i) => i.service === service).length;
    return `${n} instance${n > 1 ? 's' : ''}`;
  }

  protected request() {
    this.api.requestProfile({ service: this.service(), kind: this.kind(), seconds: this.seconds() }).subscribe((p) => {
      this.waitingFor.set(p.id);
      this.selectedId.set(null);
      this.tree.set(null);
      this.load();
    });
  }

  protected open(p: ProfileInfo) {
    if (p.status !== 'done') return;
    this.openById(p.id);
  }

  private openById(id: string) {
    this.selectedId.set(id);
    this.api.profile(id).subscribe((d) => {
      if (this.selectedId() === id) this.tree.set(buildTree(d.stacks));
    });
  }

  protected describeTotal(p: ProfileInfo) {
    if (p.kind === 'alloc') return `${(p.total / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo alloués`;
    return `${p.samples.toLocaleString('fr-FR')} échantillons`;
  }

  protected pct(v: number) {
    return ((100 * v) / (this.tree()?.value || 1)).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %';
  }

  protected round(v: number) {
    return Math.round(v);
  }

  protected shortOf(name: string) {
    return shortName(name);
  }
}
