import { Component, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { ErrorGroup, ErrorList } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { CountUp } from '../shared/count-up';
import { ErrorStatusTag } from '../shared/error-status-tag';
import { NavIcon } from '../shared/nav-icon';
import { SavedSearches } from '../shared/saved-searches';
import { Skeleton } from '../shared/skeleton';

type Tab = 'todo' | 'mine' | 'resolved' | 'ignored' | 'all';

/** Une erreur vue pour la première fois depuis moins longtemps est signalée « nouvelle ». */
const NEW_FOR_MS = 24 * 3600_000;

/** Libellés des changements de statut (notifications), au singulier puis au pluriel. */
const STATUS_DONE: Record<string, [string, string]> = {
  resolved: ['marquée résolue', 'marquées résolues'],
  ignored: ['ignorée', 'ignorées'],
  open: ['remise à traiter', 'remises à traiter'],
};

@Component({
  selector: 'wl-errors',
  imports: [FormsModule, RouterLink, NumPipe, AgoPipe, ErrorStatusTag, SavedSearches, NavIcon, CountUp, Skeleton],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Erreurs</h1>
        <div class="seg tabs" role="tablist">
          @for (t of tabs; track t.id) {
            @if (t.id !== 'mine' || session.me()?.authEnabled) {
              <button role="tab" [class.on]="tab() === t.id" [attr.aria-selected]="tab() === t.id" (click)="setTab(t.id)" [title]="t.hint">
                <wl-nav-icon [name]="t.icon" [size]="13" />{{ t.label }}
                @if (counts(); as c) { <span class="count" [class.hot]="t.id === 'todo' && c.todo > 0" [wlCountUp]="c[t.id] | num"></span> }
              </button>
            }
          }
        </div>
        <label class="check small crash-only" title="N'afficher que les erreurs qui ont arrêté le processus">
          <input type="checkbox" class="switch" [checked]="crashOnly()" (change)="crashOnly.set(!crashOnly())" />
          <wl-nav-icon name="crash" [size]="13" />Crashs seulement
        </label>
        <span class="spacer"></span>
        <div class="find">
          <wl-nav-icon name="search" [size]="14" class="find-icon" />
          <input [ngModel]="text" (ngModelChange)="typed($event)" placeholder="Type ou message de l'exception" class="filter" aria-label="Filtrer" />
          @if (text) {
            <button type="button" class="clear" (click)="clearText()" title="Effacer le filtre" aria-label="Effacer le filtre"><wl-nav-icon name="close" [size]="12" /></button>
          }
        </div>
        <wl-saved-searches page="errors" [params]="currentParams()" (apply)="applySaved($event)" />
      </div>

      @if (selected().size && session.canEdit()) {
        <div class="bulk panel" animate.leave="bulk-out">
          <span class="picked"><strong class="num">{{ selected().size }}</strong> sélectionnée{{ selected().size > 1 ? 's' : '' }}</span>
          <button class="btn" (click)="bulk('resolved')"><wl-nav-icon name="ok" [size]="14" />Marquer résolues</button>
          <button class="btn" (click)="bulk('ignored')"><wl-nav-icon name="mute" [size]="14" />Ignorer</button>
          <button class="btn" (click)="bulk('open')"><wl-nav-icon name="inbox" [size]="14" />Remettre à traiter</button>
          <span class="spacer"></span>
          <button class="btn ghost" (click)="clearSelection()"><wl-nav-icon name="close" [size]="14" />Annuler la sélection</button>
        </div>
      }

      <section class="panel">
        @if (groups().length) {
          <table class="list">
            <thead>
              <tr>
                @if (session.canEdit()) {
                  <th class="sel"><input type="checkbox" [checked]="allSelected()" (change)="toggleAll()" aria-label="Tout sélectionner" /></th>
                }
                <th>Exception</th><th>Service</th><th class="hide-sm">Assignée à</th><th class="r">Occurrences</th><th class="hide-sm">Dernière</th><th class="hide-sm">Première</th>
                @if (session.canEdit()) { <th class="acts hide-sm"></th> }
                <th class="go"></th>
              </tr>
            </thead>
            <tbody>
              @for (g of groups(); track g.fingerprint; let i = $index) {
                <tr class="click" [class.cur]="i === cursor()" [class.picked]="selected().has(g.fingerprint)" (click)="open(g)" (mouseenter)="cursor.set(i)">
                  @if (session.canEdit()) {
                    <td class="sel" (click)="$event.stopPropagation()">
                      <input type="checkbox" [checked]="selected().has(g.fingerprint)" (change)="toggle(g.fingerprint)" [attr.aria-label]="'Sélectionner ' + g.exceptionType" />
                    </td>
                  }
                  <td class="main">
                    <div class="ellipsis head-line">
                      @if (g.crashes) { <span class="tag crash" [title]="(g.crashes | num) + ' occurrence(s) ont arrêté le processus'">crash</span> }
                      @if (isNew(g)) { <span class="tag new" title="Vue pour la première fois il y a moins de 24 h">nouvelle</span> }
                      <wl-error-status [status]="g.status" />
                      <a class="mono type" [routerLink]="['/errors', g.fingerprint]" (click)="$event.stopPropagation()" [title]="g.exceptionType">{{ g.exceptionType }}</a>
                    </div>
                    <div class="muted small ellipsis" [title]="g.message ?? ''">{{ g.message }}</div>
                  </td>
                  <td class="nowrap">{{ g.service }}@if (g.services > 1) { <span class="more" [title]="'Touche ' + g.services + ' services'">+{{ g.services - 1 }}</span> }</td>
                  <td class="nowrap small hide-sm">
                    @if (g.assignedTo) { <span class="person"><i class="avatar">{{ initials(personName(g.assignedTo)) }}</i>{{ personName(g.assignedTo) }}</span> }
                  </td>
                  <td class="r occ">
                    <span class="num">{{ g.count | num }}</span>
                    <i class="occ-bar" [style.--w]="g.count / maxCount()"></i>
                  </td>
                  <td class="muted nowrap hide-sm" [title]="fullDate(g.lastSeen)">{{ g.lastSeen | ago }}</td>
                  <td class="muted nowrap hide-sm" [title]="fullDate(g.firstSeen)">{{ g.firstSeen | ago }}</td>
                  @if (session.canEdit()) {
                    <td class="acts nowrap hide-sm" (click)="$event.stopPropagation()">
                      @if (g.status === 'resolved' || g.status === 'ignored') {
                        <button class="btn ghost" (click)="setStatus(g, 'open')" title="Remettre à traiter"><wl-nav-icon name="inbox" [size]="13" />Rouvrir</button>
                      } @else {
                        <button class="btn ghost resolve" (click)="setStatus(g, 'resolved')" title="Résolue (R)"><wl-nav-icon name="ok" [size]="13" />Résoudre</button>
                        <button class="btn ghost" (click)="setStatus(g, 'ignored')" title="Ignorer (I)"><wl-nav-icon name="mute" [size]="13" />Ignorer</button>
                      }
                    </td>
                  }
                  <td class="go"><wl-nav-icon name="chevron-right" [size]="14" /></td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loading() || loadError()) {
          <div class="empty" [class.all-clear]="!loadError() && !applied() && !crashOnly() && tab() === 'todo'">
            <p class="lead-text">{{ loadError() || emptyText() }}</p>
            <p class="hint">{{ loadError() ? 'Vérifiez la connexion au serveur, puis réessayez.' : emptyHint() }}</p>
            <div class="cta">
              @if (loadError()) {
                <button class="btn" (click)="load()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button>
              } @else if (applied() || crashOnly()) {
                <button class="btn" (click)="clearFilters()"><wl-nav-icon name="close" [size]="14" />Effacer les filtres</button>
              } @else if (tab() !== 'all') {
                <button class="btn" (click)="setTab('all')"><wl-nav-icon name="list" [size]="14" />Voir toutes les erreurs</button>
              }
              @if (!loadError() && canWiden()) {
                <button class="btn ghost" (click)="widen()"><wl-nav-icon name="calendar" [size]="14" />Élargir à 7 jours</button>
              }
            </div>
          </div>
        } @else {
          <wl-skeleton [rows]="8" />
        }
      </section>
      @if (groups().length) {
        <p class="muted small keys"><kbd>↑</kbd> <kbd>↓</kbd> parcourir · <kbd>Entrée</kbd> ouvrir
          @if (session.canEdit()) { · <kbd>R</kbd> résoudre · <kbd>I</kbd> ignorer }</p>
      }
    </div>
  `,
  styles: `
    .tabs button { display: inline-flex; align-items: center; gap: 6px; }
    .tabs wl-nav-icon { color: var(--text-3); transition: color .25s, transform .4s var(--spring); }
    .tabs button:hover wl-nav-icon { transform: scale(1.15) rotate(-6deg); }
    .tabs button.on wl-nav-icon { color: var(--accent); }
    .count { min-width: 18px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/16px var(--mono); text-align: center; font-variant-numeric: tabular-nums;
      color: var(--text-3); background: var(--surface-3); transition: color .25s, background-color .25s; }
    .tabs button.on .count { color: var(--text-1); background: color-mix(in srgb, var(--accent) 22%, transparent); }
    .count.hot { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .crash-only wl-nav-icon { color: var(--crash); }
    .find { position: relative; display: flex; align-items: center; }
    .find-icon { position: absolute; left: 11px; color: var(--text-3); pointer-events: none; z-index: 1; transition: color .25s, transform .4s var(--spring); }
    .find:focus-within .find-icon { color: var(--accent); transform: scale(1.1); }
    .filter { width: 260px; padding-left: 33px; padding-right: 30px; }
    .clear { position: absolute; right: 6px; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%;
      background: var(--surface-3); color: var(--text-2); cursor: pointer; animation: pop-in .3s var(--spring); transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .clear:hover { color: var(--text-1); background: var(--accent-soft); transform: rotate(90deg); }
    @keyframes pop-in { from { opacity: 0; transform: scale(.5); } }
    .bulk { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 12px; border-color: color-mix(in srgb, var(--accent) 55%, transparent);
      box-shadow: var(--shadow), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), inset 0 1px 0 var(--highlight); }
    .bulk .picked { display: inline-flex; align-items: baseline; gap: 6px; margin-right: 6px; color: var(--text-2); }
    .bulk .picked strong { color: var(--accent); font-size: 15px; }
    .bulk-out { animation: bulk-out .2s ease-in forwards; }
    @keyframes bulk-out { to { opacity: 0; transform: translateY(-8px) scale(.98); } }
    .main { max-width: 0; width: 52%; }
    .head-line > * { vertical-align: middle; }
    .type { color: var(--text-1); font-weight: 550; transition: color .2s; }
    tr:hover .type { color: var(--accent); }
    .tag, wl-error-status { margin-right: 6px; }
    .tag.new { color: var(--accent-3); }
    .more { margin-left: 6px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/16px var(--mono); color: var(--text-2); background: var(--surface-3); }
    .person { display: inline-flex; align-items: center; gap: 7px; color: var(--text-2); }
    .avatar { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font: 700 8.5px/1 var(--sans); font-style: normal;
      color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: inset 0 1px 0 var(--highlight); }
    .occ { position: relative; }
    .occ .num { position: relative; font-weight: 550; }
    .occ-bar { position: absolute; right: 16px; bottom: 6px; width: 54px; height: 3px; border-radius: 3px; background: var(--danger); opacity: .55;
      transform: scaleX(var(--w)); transform-origin: right; }
    tbody tr:nth-child(-n+12) .occ-bar { animation: grow .7s var(--ease) .15s backwards; }
    @keyframes grow { from { transform: scaleX(0); } }
    .sel { width: 28px; padding-right: 0 !important; }
    .acts { width: 1%; text-align: right; }
    .acts .btn { height: 24px; padding: 0 8px; gap: 5px; font-size: 12px; visibility: hidden; opacity: 0; transform: translateX(6px);
      transition: opacity .2s, visibility .2s, transform .3s var(--spring), background-color .2s, color .2s; }
    tr:hover .acts .btn, tr.cur .acts .btn, tr:focus-within .acts .btn { visibility: visible; opacity: 1; transform: none; }
    .acts .btn.resolve:hover { color: var(--ok); }
    .go { width: 28px; padding-left: 0 !important; color: var(--text-3); }
    .go wl-nav-icon { opacity: .35; transition: transform .35s var(--spring), opacity .2s, color .2s; }
    tr:hover .go wl-nav-icon, tr.cur .go wl-nav-icon { opacity: 1; color: var(--accent); transform: translateX(3px); }
    tr.cur td { background: var(--row-hover); }
    tr.cur td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    tr.picked td { background: var(--row-selected); }
    .empty .lead-text { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 550; }
    .empty .hint { max-width: 460px; margin: 6px auto 0; font-size: 12.5px; }
    .empty.all-clear::before {
      -webkit-mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='m8 12 3 3 5-6'/></svg>");
      mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='m8 12 3 3 5-6'/></svg>");
      background: linear-gradient(135deg, var(--ok), var(--accent-3)); }
    .cta { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .cta:empty { display: none; }
    .keys { margin: 0; }
  `,
})
export class ErrorsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  readonly q = input<string>('');
  readonly status = input<string>('');
  protected readonly groups = signal<ErrorGroup[]>([]);
  protected readonly counts = signal<ErrorList['counts'] | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly crashOnly = signal(false);
  protected readonly applied = signal('');
  protected readonly tab = signal<Tab>('todo');
  protected readonly cursor = signal(-1);
  protected readonly selected = signal(new Set<string>());
  private readonly people = signal<Map<string, string>>(new Map());
  protected text = '';
  private sub?: Subscription;

  protected readonly tabs: { id: Tab; label: string; hint: string; icon: string }[] = [
    { id: 'todo', label: 'À traiter', hint: 'Nouvelles, non traitées et réapparues après résolution', icon: 'inbox' },
    { id: 'mine', label: 'Assignées à moi', hint: 'Erreurs qui vous sont assignées', icon: 'account' },
    { id: 'resolved', label: 'Résolues', hint: 'Marquées résolues et pas revues depuis', icon: 'ok' },
    { id: 'ignored', label: 'Ignorées', hint: 'Masquées de la vue d\'ensemble', icon: 'mute' },
    { id: 'all', label: 'Toutes', hint: 'Toutes les erreurs de la période', icon: 'list' },
  ];

  protected readonly allSelected = computed(() => this.groups().length > 0 && this.groups().every((g) => this.selected().has(g.fingerprint)));
  /** Plus grand nombre d'occurrences de la liste (échelle des barres). */
  protected readonly maxCount = computed(() => Math.max(1, ...this.groups().map((g) => g.count)));
  protected readonly currentParams = computed(() => ({
    q: [this.applied(), this.crashOnly() ? 'crash:true' : ''].filter(Boolean).join(' '),
    status: this.tab(),
  }));
  protected readonly emptyText = computed(() => {
    if (this.applied() || this.crashOnly()) return 'Aucune erreur ne correspond à ces filtres.';
    switch (this.tab()) {
      case 'todo': return 'Rien à traiter sur cette période.';
      case 'mine': return 'Aucune erreur ne vous est assignée.';
      case 'resolved': return 'Aucune erreur résolue sur cette période.';
      case 'ignored': return 'Aucune erreur ignorée.';
      default: return 'Aucune erreur sur cette période.';
    }
  });
  protected readonly emptyHint = computed(() => {
    if (this.applied() || this.crashOnly()) {
      return this.crashOnly() ? 'Retirez « Crashs seulement » ou essayez un autre type ou message d\'exception.' : 'Essayez un autre type ou message d\'exception.';
    }
    switch (this.tab()) {
      case 'todo': return 'Aucune erreur nouvelle, non traitée ou réapparue : tout est sous contrôle.';
      case 'mine': return 'Les erreurs qu\'on vous assigne depuis leur page de détail apparaîtront ici.';
      case 'resolved': return 'Les erreurs marquées résolues et pas revues depuis apparaissent ici.';
      case 'ignored': return 'Les erreurs ignorées sont masquées de la vue d\'ensemble et de la liste à traiter.';
      default: return 'Aucune exception n\'a été enregistrée par vos services sur cette période.';
    }
  });
  /** Période relative plus courte que 7 jours : on propose de l'élargir. */
  protected readonly canWiden = computed(() => this.state.isRelative() && !['7d', '30d'].includes(this.state.from()));

  constructor() {
    effect(() => {
      const q = this.q() ?? '';
      const status = this.status();
      untracked(() => {
        this.crashOnly.set(q.includes('crash:true'));
        const rest = q.replace('crash:true', '').trim();
        this.text = rest;
        this.applied.set(rest);
        if (status && this.tabs.some((t) => t.id === status)) this.tab.set(status as Tab);
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      this.crashOnly();
      this.applied();
      this.tab();
      untracked(() => this.load());
    });
    this.api.people().subscribe({ next: (p) => this.people.set(new Map(p.map((x) => [x.username, x.displayName]))), error: () => {} });
  }

  protected personName(username: string | null) {
    return username ? (this.people().get(username) ?? username) : '';
  }

  /** Initiales d'une personne pour sa pastille : « Marie Curie » → « MC ». */
  protected initials(name: string) {
    const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return (parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2)).toUpperCase();
  }

  /** Date et heure complètes, en infobulle des dates relatives. */
  protected fullDate(iso: string) {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
  }

  protected isNew(g: ErrorGroup) {
    return Date.now() - new Date(g.firstSeen).getTime() < NEW_FOR_MS;
  }

  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  protected typed(value: string) {
    this.text = value;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.applied.set(value.trim()), 300);
  }

  protected clearText() {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.text = '';
    this.applied.set('');
  }

  protected clearFilters() {
    this.clearText();
    this.crashOnly.set(false);
  }

  protected widen() {
    this.state.setRelative('7d');
  }

  protected setTab(t: Tab) {
    this.tab.set(t);
    this.selected.set(new Set());
  }

  protected applySaved(p: Record<string, string>) {
    const q = p['q'] ?? '';
    this.crashOnly.set(q.includes('crash:true'));
    this.text = q.replace('crash:true', '').trim();
    this.applied.set(this.text);
    if (p['status']) this.tab.set(p['status'] as Tab);
  }

  protected load() {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.sub = this.api.errors(this.state.range(), this.currentParams().q, this.state.service(), this.tab()).subscribe({
      next: (l) => {
        this.groups.set(l.items);
        this.counts.set(l.counts);
        this.loadError.set('');
        this.loading.set(false);
        if (this.cursor() >= l.items.length) this.cursor.set(l.items.length - 1);
      },
      error: () => {
        this.loading.set(false);
        this.loadError.set('Impossible de charger les erreurs.');
      },
    });
  }

  protected open(g: ErrorGroup) {
    this.router.navigate(['/errors', g.fingerprint]);
  }

  protected setStatus(g: ErrorGroup, status: string) {
    const type = g.exceptionType.split('.').pop() || g.exceptionType;
    this.api.setErrorState(g.fingerprint, { status }).subscribe({
      next: () => {
        this.toasts.ok(`${type} ${STATUS_DONE[status]?.[0] ?? 'mise à jour'}`, status === 'ignored' ? 'mute' : status === 'open' ? 'inbox' : 'ok');
        this.load();
      },
      error: () => this.toasts.error(`Impossible de modifier le statut de ${type}.`),
    });
  }

  protected bulk(status: string) {
    const n = this.selected().size;
    this.api.setErrorsState([...this.selected()], status).subscribe({
      next: () => {
        const [one, many] = STATUS_DONE[status] ?? ['mise à jour', 'mises à jour'];
        this.toasts.ok(n > 1 ? `${n} erreurs ${many}` : `1 erreur ${one}`, status === 'ignored' ? 'mute' : status === 'open' ? 'inbox' : 'ok');
        this.selected.set(new Set());
        this.load();
      },
      error: () => this.toasts.error('Impossible de modifier le statut des erreurs sélectionnées.'),
    });
  }

  protected toggle(fp: string) {
    const next = new Set(this.selected());
    if (next.has(fp)) next.delete(fp);
    else next.add(fp);
    this.selected.set(next);
  }

  protected clearSelection() {
    this.selected.set(new Set());
  }

  protected toggleAll() {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.groups().map((g) => g.fingerprint)));
  }

  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const list = this.groups();
    if (!list.length) return;
    const i = this.cursor();
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      this.moveCursor(Math.min(list.length - 1, i + 1));
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      this.moveCursor(Math.max(0, i - 1));
    } else if (e.key === 'Enter' && list[i] && !target.closest('button, a')) {
      this.open(list[i]);
    } else if ((e.key === 'r' || e.key === 'i') && list[i] && this.session.canEdit()) {
      this.setStatus(list[i], e.key === 'r' ? 'resolved' : 'ignored');
    }
  }

  /** Curseur clavier : la ligne choisie reste visible. */
  private moveCursor(i: number) {
    this.cursor.set(i);
    this.host.querySelectorAll('tbody tr')[i]?.scrollIntoView({ block: 'nearest' });
  }
}
