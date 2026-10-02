import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { ProfileInfo, ProfilingInstance } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { CodeBlock } from '../shared/code-block';
import { FlameGraph, FlameNode, buildTree, shortName } from '../shared/flamegraph';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { Skeleton } from '../shared/skeleton';

/** Largeurs (%) des rangées du squelette de graphe en flammes : de plus en plus étroites vers le bas. */
const GHOST_FLAME = [100, 92, 78, 64, 52, 40, 30, 18];

@Component({
  selector: 'wl-profiles',
  imports: [FormsModule, AgoPipe, TimePipe, CodeBlock, FlameGraph, NavIcon, RichOption, Skeleton],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Profils</h1>
        <span class="muted small">où l'application passe son temps (CPU) et ce qu'elle alloue (mémoire), à la demande</span>
        <span class="spacer"></span>
        @if (session.canEdit()) {
          <select class="svc-select" [ngModel]="service()" (ngModelChange)="service.set($event)" aria-label="Service à profiler">
            @for (s of services(); track s) { <option [value]="s" [wlOpt]="s" avatar [meta]="countFor(s)" metaTone="muted"></option> }
            @if (!services().length) { <option value="" wlOpt="aucune application prête" icon="info" tone="muted" desc="Activez le profilage dans une application (voir ci-dessous)"></option> }
          </select>
          <div class="seg" role="group" aria-label="Type de profil">
            <button type="button" [class.on]="kind() === 'cpu'" (click)="kind.set('cpu')" title="Temps processeur passé dans chaque méthode"><wl-nav-icon name="gauge" [size]="13" />CPU</button>
            <button type="button" [class.on]="kind() === 'alloc'" (click)="kind.set('alloc')" title="Mémoire allouée par chaque méthode"><wl-nav-icon name="database" [size]="13" />Mémoire</button>
          </div>
          <select [ngModel]="seconds()" (ngModelChange)="seconds.set(+$event)" aria-label="Durée">
            <option [value]="15" wlOpt="15 s" icon="timer" desc="Aperçu rapide"></option>
            <option [value]="30" wlOpt="30 s" icon="timer" desc="Recommandé"></option>
            <option [value]="60" wlOpt="60 s" icon="timer" desc="Plus d'échantillons, plus précis"></option>
          </select>
          <button class="btn primary go" (click)="request()" [disabled]="!service() || running() || requesting()">
            <wl-nav-icon [name]="running() || requesting() ? 'refresh' : 'play'" [size]="14" [class.spin]="running() || requesting()" />
            {{ running() ? 'Profil en cours…' : 'Profiler maintenant' }}
          </button>
        }
      </div>

      @if (instancesLoaded() && !instances().length) {
        <section class="panel setup">
          <div class="panel-head">
            <span class="h-icon"><wl-nav-icon name="profiles" [size]="16" /></span>
            <h2>Activer le profilage dans une application .NET</h2>
          </div>
          <div class="panel-body">
            <ol class="steps small">
              <li><strong>Ajouter le paquet</strong> <span class="mono">Wolflog.Client.Profiling</span></li>
              <li><strong>L'activer</strong> dans Program.cs, après <span class="mono">AddWolflog()</span></li>
              <li><strong>Redémarrer</strong> l'application : elle apparaît dans la liste en haut de page</li>
            </ol>
            <wl-code [code]="setup" />
            <p class="muted small">Aucun coût tant qu'aucun profil n'est demandé : l'application interroge Wolflog toutes les 10 secondes.
              Pendant un profil, l'échantillonnage (EventPipe, comme dotnet-trace) ralentit l'application de quelques pour cent.</p>
          </div>
        </section>
      }

      <div class="layout">
        <section class="panel list">
          <div class="panel-head">
            <h2 class="with-icon"><wl-nav-icon name="clock" [size]="15" />Historique</h2>
            @if (profiles().length) { <span class="count">{{ profiles().length }}</span> }
          </div>
          @if (!profilesLoaded()) {
            <wl-skeleton [rows]="6" />
          } @else {
            @for (p of profiles(); track p.id; let i = $index) {
              <button class="item" [class.on]="p.id === selectedId()" [attr.data-status]="p.status" [style.--i]="i" (click)="open(p)"
                      [disabled]="p.status === 'pending' || p.status === 'running'">
                <span class="k-icon" [class.alloc]="p.kind === 'alloc'"><wl-nav-icon [name]="p.kind === 'alloc' ? 'database' : 'gauge'" [size]="15" /></span>
                <span class="item-text">
                  <span class="row1">
                    <span class="kind">{{ p.kind === 'alloc' ? 'Mémoire' : 'CPU' }}</span>
                    <span class="ellipsis svc" [title]="p.service">{{ p.service }}</span>
                    <span class="spacer"></span>
                    <span class="muted small nowrap">{{ p.requestedAt | ago }}</span>
                  </span>
                  <span class="row2 small">
                    @switch (p.status) {
                      @case ('pending') { <span class="warn status"><wl-nav-icon name="clock" [size]="12" class="wait" />en attente de l'application…</span> }
                      @case ('running') { <span class="warn status"><wl-nav-icon name="timer" [size]="13" />enregistrement ({{ p.seconds }} s)…</span> }
                      @case ('failed') { <span class="danger status" [title]="p.error ?? ''"><wl-nav-icon name="warning" [size]="12" /><span class="ellipsis">{{ p.error }}</span></span> }
                      @default { <span class="muted ellipsis">{{ p.host ?? '' }} · {{ round(p.seconds) }} s · {{ describeTotal(p) }}</span> }
                    }
                  </span>
                  @if (p.status === 'running' && elapsed(p) !== null) {
                    <span class="track" [title]="'≈ ' + remaining(p) + ' s restantes'">
                      <i class="fill" [style.transform]="'scaleX(' + progress(p) + ')'"></i>
                    </span>
                  } @else if (p.status === 'pending' || p.status === 'running') {
                    <span class="track"><i class="sweep"></i></span>
                  }
                </span>
              </button>
            } @empty {
              <div class="empty small none">
                <wl-nav-icon name="profiles" [size]="20" class="none-icon" />
                Aucun profil pour l'instant.
                @if (session.canEdit() && services().length) { <span>Lancez-en un avec « Profiler maintenant ».</span> }
              </div>
            }
          }
        </section>

        <section class="panel viewer">
          @if (tree(); as t) {
            <div class="panel-head">
              <span class="h-icon" [class.alloc]="selected()?.kind === 'alloc'"><wl-nav-icon [name]="selected()?.kind === 'alloc' ? 'database' : 'gauge'" [size]="16" /></span>
              <div class="v-title">
                <h2 class="ellipsis">{{ selected()?.kind === 'alloc' ? 'Allocations' : 'Temps CPU' }} de {{ selected()?.service }}</h2>
                <span class="muted small">{{ selected()?.start | time: true }} · {{ selected()?.host }} {{ selected()?.version ? '· v' + selected()?.version : '' }}</span>
              </div>
            </div>
            <div class="panel-body">
              <wl-flamegraph #fg [root]="t" [kind]="selected()?.kind === 'alloc' ? 'alloc' : 'cpu'" />
              <h3 class="with-icon"><wl-nav-icon name="trend-up" [size]="13" />{{ selected()?.kind === 'alloc' ? 'Méthodes qui allouent le plus' : 'Méthodes les plus coûteuses' }} (temps propre)</h3>
              <table class="list">
                <tbody>
                  @for (m of topSelf(); track m.name; let i = $index) {
                    <tr class="click" [class.on]="fg.search() === shortOf(m.name)" (click)="highlight(fg, m.name)"
                        [title]="m.name + '\\nCliquer pour surligner dans le graphe'">
                      <td class="rank muted small">{{ i + 1 }}</td>
                      <td class="mono small ellipsis name">{{ m.name }}</td>
                      <td class="r mono small nowrap">{{ pct(m.self) }}</td>
                      <td class="bar-cell"><span class="barline" [style.--i]="i" [style.transform]="'scaleX(' + barShare(m.self) + ')'"></span></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (treeLoading()) {
            <div class="panel-head"><i class="skeleton" style="width: 34px; height: 34px; border-radius: 11px"></i><i class="skeleton" style="width: 40%; height: 13px"></i></div>
            <div class="panel-body ghost-flame" aria-busy="true">
              @for (w of ghostFlame; track $index) { <i class="skeleton" [style.width.%]="w"></i> }
            </div>
          } @else {
            <div class="empty" [class.recording]="running()">
              @if (running()) {
                <p>Enregistrement en cours : le profil s'affichera ici automatiquement.</p>
              } @else {
                <p>Choisissez un profil, ou lancez-en un avec « Profiler maintenant ».</p>
                @if (session.canEdit() && service()) {
                  <button class="btn primary" (click)="request()" [disabled]="requesting()"><wl-nav-icon name="play" [size]="14" />Profiler {{ service() }}</button>
                }
              }
            </div>
          }
        </section>
      </div>
    </div>
  `,
  styles: `
    .svc-select { min-width: 190px; }
    .seg button { display: inline-flex; align-items: center; gap: 6px; }
    .seg button wl-nav-icon { opacity: .7; transition: opacity .2s, transform .35s var(--spring); }
    .seg button.on wl-nav-icon { opacity: 1; transform: scale(1.12); }
    .go wl-nav-icon { transition: transform .35s var(--spring); }
    .go:hover:not(:disabled) wl-nav-icon:not(.spin) { transform: scale(1.2); }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .with-icon { display: inline-flex; align-items: center; gap: 8px; }
    .with-icon wl-nav-icon { color: var(--accent); }
    .count { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
      font: 650 11px var(--mono); color: var(--accent); background: var(--accent-soft); }
    .h-icon { display: grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 11px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -8px var(--accent), inset 0 1px 0 rgb(255 255 255 / .35);
      animation: icon-pop .5s var(--spring) backwards; }
    .h-icon.alloc { background: linear-gradient(135deg, var(--accent-3), var(--accent)); }
    @keyframes icon-pop { from { opacity: 0; transform: scale(.5) rotate(-15deg); } }
    .steps { display: grid; gap: 6px; margin: 0 0 12px; padding-left: 20px; color: var(--text-2); }
    .steps li::marker { color: var(--accent); font-weight: 700; }
    .layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 14px; align-items: start; }
    /* Historique : pastille de type, statut, barre de progression pendant l'enregistrement. */
    .list { max-height: calc(100vh - 140px); overflow: auto; }
    .item { position: relative; display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 9px 12px; border: 0; border-bottom: 1px solid var(--border-soft);
      background: none; color: var(--text-1); font: 13px var(--sans); text-align: left; cursor: pointer; transition: background-color .15s;
      animation: item-in .4s var(--ease) backwards; animation-delay: min(calc(var(--i) * 30ms), 300ms); }
    @keyframes item-in { from { opacity: 0; transform: translateX(-6px); } }
    .item:hover:not(:disabled) { background: var(--row-hover); }
    .item.on { background: var(--row-selected); box-shadow: inset 3px 0 0 var(--accent); }
    .item:disabled { cursor: default; }
    .k-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 10px; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent); transition: transform .4s var(--spring); }
    .k-icon.alloc { color: var(--accent-3); background: color-mix(in srgb, var(--accent-3) 14%, transparent); }
    .item:hover:not(:disabled) .k-icon { transform: rotate(-8deg) scale(1.08); }
    .item.on .k-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .item[data-status='failed'] .k-icon { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .item-text { display: grid; gap: 2px; flex: 1; min-width: 0; }
    .row1 { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
    .row2 { display: flex; min-width: 0; }
    .svc { font-weight: 550; }
    .kind { font: 650 10.5px var(--mono); text-transform: uppercase; color: var(--text-3); letter-spacing: .04em; }
    .warn { color: var(--warn); }
    .status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
    .status .ellipsis { min-width: 0; }
    .wait { animation: spin 3s linear infinite; }
    .track { position: relative; display: block; height: 3px; margin-top: 5px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    /* Progression recalculée à chaque actualisation (3 s) : la transition linéaire comble l'intervalle. */
    .track .fill { position: absolute; inset: 0; transform-origin: left; background: linear-gradient(90deg, var(--warn), var(--accent));
      transition: transform 3s linear; }
    .track .sweep { position: absolute; top: 0; bottom: 0; left: 0; width: 40%; background: linear-gradient(90deg, transparent, var(--warn), transparent);
      animation: sweep 1.3s var(--ease) infinite; }
    @keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
    .none { display: grid; justify-items: center; gap: 6px; padding: 28px 12px; }
    .none-icon { color: var(--text-3); }
    /* Visionneuse */
    .viewer .panel-head { gap: 12px; }
    .v-title { display: grid; min-width: 0; }
    h3 { margin: 18px 0 8px; }
    .rank { width: 28px; text-align: right; font-variant-numeric: tabular-nums; }
    .name { max-width: 0; width: 64%; }
    tr.on td { background-color: var(--row-selected); }
    tr.on td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    .bar-cell { width: 25%; }
    .barline { display: block; height: 6px; border-radius: 999px; transform-origin: left; opacity: .75;
      background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: opacity .2s, transform .5s var(--ease);
      animation: bar-grow .7s var(--ease) backwards; animation-delay: min(calc(var(--i) * 35ms + 100ms), 600ms); }
    @keyframes bar-grow { from { transform: scaleX(0); } }
    tr:hover .barline, tr.on .barline { opacity: 1; }
    .ghost-flame { display: grid; gap: 3px; }
    .ghost-flame i { height: 15px; border-radius: 3px; }
    .empty p { margin: 0 auto 8px; max-width: 420px; }
    .empty .btn { margin-top: 6px; }
    .setup p { margin: 8px 0 0; }
    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }
  `,
})
export class ProfilesPage {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  private readonly toasts = inject(Toasts);
  protected readonly session = inject(Session);
  readonly id = input<string>('');

  protected readonly instances = signal<ProfilingInstance[]>([]);
  protected readonly instancesLoaded = signal(false);
  protected readonly profiles = signal<ProfileInfo[]>([]);
  protected readonly profilesLoaded = signal(false);
  protected readonly service = signal('');
  protected readonly kind = signal<'cpu' | 'alloc'>('cpu');
  protected readonly seconds = signal(30);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly tree = signal<FlameNode | null>(null);
  protected readonly treeLoading = signal(false);
  protected readonly requesting = signal(false);
  protected readonly ghostFlame = GHOST_FLAME;
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
    this.api.profilingInstances().subscribe({
      next: (i) => {
        this.instances.set(i);
        this.instancesLoaded.set(true);
        const current = this.service();
        if (!current || !this.services().includes(current)) {
          const preferred = this.state.service();
          this.service.set(this.services().includes(preferred) ? preferred : (this.services()[0] ?? ''));
        }
      },
      error: () => this.instancesLoaded.set(true),
    });
    this.api.profiles().subscribe({
      next: (list) => {
        this.profiles.set(list);
        this.profilesLoaded.set(true);
        // Profil demandé depuis cette page : ouvert dès qu'il arrive.
        const waiting = this.waitingFor();
        const done = waiting ? list.find((p) => p.id === waiting && p.status !== 'pending' && p.status !== 'running') : null;
        if (done) {
          this.waitingFor.set(null);
          if (done.status === 'done') {
            this.toasts.ok(`Profil ${done.kind === 'alloc' ? 'mémoire' : 'CPU'} de ${done.service} prêt`, 'profiles');
            this.open(done);
          } else {
            this.toasts.error(`Profil en échec${done.error ? ' : ' + done.error : ''}`);
          }
        } else if (!this.selectedId() && !waiting) {
          const latest = list.find((p) => p.status === 'done');
          if (latest) this.open(latest);
        }
      },
      error: () => this.profilesLoaded.set(true),
    });
  }

  protected countFor(service: string) {
    const n = this.instances().filter((i) => i.service === service).length;
    return `${n} instance${n > 1 ? 's' : ''}`;
  }

  protected request() {
    if (this.requesting()) return;
    this.requesting.set(true);
    const service = this.service();
    const seconds = this.seconds();
    this.api.requestProfile({ service, kind: this.kind(), seconds }).subscribe({
      next: (p) => {
        this.requesting.set(false);
        this.waitingFor.set(p.id);
        this.selectedId.set(null);
        this.tree.set(null);
        this.toasts.info(`Profil demandé : ${service}, ${seconds} s d'enregistrement`, 'play');
        this.load();
      },
      error: () => {
        this.requesting.set(false);
        this.toasts.error('Impossible de demander un profil.');
      },
    });
  }

  protected open(p: ProfileInfo) {
    if (p.status !== 'done') return;
    this.openById(p.id);
  }

  private openById(id: string) {
    if (this.selectedId() === id && this.tree()) return;
    this.selectedId.set(id);
    this.tree.set(null);
    this.treeLoading.set(true);
    this.api.profile(id).subscribe({
      next: (d) => {
        if (this.selectedId() !== id) return;
        this.tree.set(buildTree(d.stacks));
        this.treeLoading.set(false);
      },
      error: () => {
        if (this.selectedId() !== id) return;
        this.treeLoading.set(false);
        this.toasts.error('Impossible de charger ce profil.');
      },
    });
  }

  /** Surligne une méthode dans le graphe (un second clic l'efface) et ramène le graphe à l'écran. */
  protected highlight(fg: FlameGraph, name: string) {
    const term = shortName(name);
    fg.search.set(fg.search() === term ? '' : term);
    if (fg.search()) fg.reveal();
  }

  /** Secondes écoulées depuis le début de l'enregistrement (null si inconnu). */
  protected elapsed(p: ProfileInfo): number | null {
    const start = Date.parse(p.start);
    if (!Number.isFinite(start) || start <= 0) return null;
    const s = (Date.now() - start) / 1000;
    return s >= 0 && s <= p.seconds + 30 ? Math.min(s, p.seconds) : null;
  }

  /** Part de l'enregistrement déjà faite (0–1). */
  protected progress(p: ProfileInfo) {
    return Math.max(0.02, Math.min(1, (this.elapsed(p) ?? 0) / (p.seconds || 1)));
  }

  protected remaining(p: ProfileInfo) {
    return Math.max(0, Math.round(p.seconds - (this.elapsed(p) ?? 0)));
  }

  protected describeTotal(p: ProfileInfo) {
    if (p.kind === 'alloc') return `${(p.total / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo alloués`;
    return `${p.samples.toLocaleString('fr-FR')} échantillons`;
  }

  protected pct(v: number) {
    return ((100 * v) / (this.tree()?.value || 1)).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %';
  }

  /** Longueur de la barre (0–1), relative à la méthode la plus coûteuse. */
  protected barShare(v: number) {
    return Math.max(0.02, v / (this.topSelf()[0]?.self || 1));
  }

  protected round(v: number) {
    return Math.round(v);
  }

  protected shortOf(name: string) {
    return shortName(name);
  }
}
