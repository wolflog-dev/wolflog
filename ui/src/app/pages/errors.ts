import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api, ErrorGroup, ErrorList } from '../core/api';
import { AppState, Session } from '../core/state';
import { AgoPipe, NumPipe } from '../core/format';
import { ErrorStatusTag } from '../shared/widgets';
import { SavedSearches } from '../shared/saved-searches';

type Tab = 'todo' | 'mine' | 'resolved' | 'ignored' | 'all';

@Component({
  selector: 'wl-errors',
  imports: [FormsModule, RouterLink, NumPipe, AgoPipe, ErrorStatusTag, SavedSearches],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Erreurs</h1>
        <div class="seg" role="tablist">
          @for (t of tabs; track t.id) {
            @if (t.id !== 'mine' || session.me()?.authEnabled) {
              <button role="tab" [class.on]="tab() === t.id" (click)="setTab(t.id)" [title]="t.hint">
                {{ t.label }} <span class="count">{{ counts()?.[t.id] ?? '' }}</span>
              </button>
            }
          }
        </div>
        <label class="check small"><input type="checkbox" [checked]="crashOnly()" (change)="crashOnly.set(!crashOnly())" /> Crashs seulement</label>
        <span class="spacer"></span>
        <input [ngModel]="text" (ngModelChange)="typed($event)" placeholder="Type ou message de l'exception" class="filter" aria-label="Filtrer" />
        <wl-saved-searches page="errors" [params]="currentParams()" (apply)="applySaved($event)" />
      </div>

      @if (selected().size && session.canEdit()) {
        <div class="bulk panel">
          <strong>{{ selected().size }} sélectionnée(s)</strong>
          <button class="btn" (click)="bulk('resolved')">Marquer résolues</button>
          <button class="btn" (click)="bulk('ignored')">Ignorer</button>
          <button class="btn" (click)="bulk('open')">Remettre à traiter</button>
          <button class="btn ghost" (click)="clearSelection()">Annuler la sélection</button>
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
                <th>Exception</th><th>Service</th><th>Assignée à</th><th class="r">Occurrences</th><th>Dernière</th><th>Première</th>
                @if (session.canEdit()) { <th class="acts"></th> }
              </tr>
            </thead>
            <tbody>
              @for (g of groups(); track g.fingerprint; let i = $index) {
                <tr class="click" [class.cur]="i === cursor()" (click)="open(g)" (mouseenter)="cursor.set(i)">
                  @if (session.canEdit()) {
                    <td class="sel" (click)="$event.stopPropagation()">
                      <input type="checkbox" [checked]="selected().has(g.fingerprint)" (change)="toggle(g.fingerprint)" [attr.aria-label]="'Sélectionner ' + g.exceptionType" />
                    </td>
                  }
                  <td class="main">
                    <div class="ellipsis">
                      @if (g.crashes) { <span class="tag crash">crash</span> }
                      <wl-error-status [status]="g.status" />
                      <a class="mono" [routerLink]="['/errors', g.fingerprint]" (click)="$event.stopPropagation()">{{ g.exceptionType }}</a>
                    </div>
                    <div class="muted small ellipsis">{{ g.message }}</div>
                  </td>
                  <td class="nowrap">{{ g.service }}@if (g.services > 1) { <span class="muted"> +{{ g.services - 1 }}</span> }</td>
                  <td class="nowrap small">{{ personName(g.assignedTo) }}</td>
                  <td class="r">{{ g.count | num }}</td>
                  <td class="muted nowrap">{{ g.lastSeen | ago }}</td>
                  <td class="muted nowrap">{{ g.firstSeen | ago }}</td>
                  @if (session.canEdit()) {
                    <td class="acts nowrap" (click)="$event.stopPropagation()">
                      @if (g.status === 'resolved' || g.status === 'ignored') {
                        <button class="btn ghost" (click)="setStatus(g, 'open')" title="Remettre à traiter">Rouvrir</button>
                      } @else {
                        <button class="btn ghost" (click)="setStatus(g, 'resolved')" title="Résolue (R)">Résoudre</button>
                        <button class="btn ghost" (click)="setStatus(g, 'ignored')" title="Ignorer (I)">Ignorer</button>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loading()) {
          <div class="empty">{{ emptyText() }}</div>
        }
      </section>
      @if (groups().length) {
        <p class="muted small keys"><kbd>↑</kbd> <kbd>↓</kbd> parcourir · <kbd>Entrée</kbd> ouvrir
          @if (session.canEdit()) { · <kbd>R</kbd> résoudre · <kbd>I</kbd> ignorer }</p>
      }
    </div>
  `,
  styles: `
    .filter { width: 240px; }
    .main { max-width: 0; width: 55%; }
    .main a { color: var(--text-1); }
    .tag, wl-error-status { margin-right: 6px; }
    .count { color: var(--text-3); font-variant-numeric: tabular-nums; margin-left: 2px; }
    .sel { width: 28px; padding-right: 0 !important; }
    .acts { width: 1%; text-align: right; }
    .acts .btn { height: 22px; padding: 0 6px; font-size: 12px; visibility: hidden; }
    tr:hover .acts .btn, tr.cur .acts .btn { visibility: visible; }
    tr.cur td { background: var(--row-hover); }
    .bulk { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-color: var(--accent); }
    .keys { margin: 0; }
  `,
})
export class ErrorsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);
  readonly q = input<string>('');
  readonly status = input<string>('');
  protected readonly groups = signal<ErrorGroup[]>([]);
  protected readonly counts = signal<ErrorList['counts'] | null>(null);
  protected readonly loading = signal(false);
  protected readonly crashOnly = signal(false);
  protected readonly applied = signal('');
  protected readonly tab = signal<Tab>('todo');
  protected readonly cursor = signal(-1);
  protected readonly selected = signal(new Set<string>());
  private readonly people = signal<Map<string, string>>(new Map());
  protected text = '';
  private sub?: Subscription;

  protected readonly tabs: { id: Tab; label: string; hint: string }[] = [
    { id: 'todo', label: 'À traiter', hint: 'Nouvelles, non traitées et réapparues après résolution' },
    { id: 'mine', label: 'Assignées à moi', hint: 'Erreurs qui vous sont assignées' },
    { id: 'resolved', label: 'Résolues', hint: 'Marquées résolues et pas revues depuis' },
    { id: 'ignored', label: 'Ignorées', hint: 'Masquées de la vue d\'ensemble' },
    { id: 'all', label: 'Toutes', hint: 'Toutes les erreurs de la période' },
  ];

  protected readonly allSelected = computed(() => this.groups().length > 0 && this.groups().every((g) => this.selected().has(g.fingerprint)));
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

  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  protected typed(value: string) {
    this.text = value;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.applied.set(value.trim()), 300);
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

  private load() {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.sub = this.api.errors(this.state.range(), this.currentParams().q, this.state.service(), this.tab()).subscribe({
      next: (l) => {
        this.groups.set(l.items);
        this.counts.set(l.counts);
        this.loading.set(false);
        if (this.cursor() >= l.items.length) this.cursor.set(l.items.length - 1);
      },
      error: () => this.loading.set(false),
    });
  }

  protected open(g: ErrorGroup) {
    this.router.navigate(['/errors', g.fingerprint]);
  }

  protected setStatus(g: ErrorGroup, status: string) {
    this.api.setErrorState(g.fingerprint, { status }).subscribe(() => this.load());
  }

  protected bulk(status: string) {
    this.api.setErrorsState([...this.selected()], status).subscribe(() => {
      this.selected.set(new Set());
      this.load();
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
      this.cursor.set(Math.min(list.length - 1, i + 1));
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      this.cursor.set(Math.max(0, i - 1));
    } else if (e.key === 'Enter' && list[i]) {
      this.open(list[i]);
    } else if ((e.key === 'r' || e.key === 'i') && list[i] && this.session.canEdit()) {
      this.setStatus(list[i], e.key === 'r' ? 'resolved' : 'ignored');
    }
  }
}
