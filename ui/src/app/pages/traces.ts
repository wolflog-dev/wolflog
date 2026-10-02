import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { TraceSummary } from '../core/models';
import { AppState } from '../core/app-state';
import { DurPipe } from '../core/pipes/dur-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';

/** Opération HTTP (« GET /api/orders ») : méthode affichée en pastille. */
const HTTP_OPERATION = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (.+)$/;

@Component({
  selector: 'wl-traces',
  imports: [FormsModule, DurPipe, TimePipe, NumPipe, NavIcon, CountUp, Skeleton],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Traces</h1>
        <div class="find">
          <wl-nav-icon name="search" [size]="14" class="find-icon" />
          <input [ngModel]="text()" (ngModelChange)="typed($event)" placeholder="Opération, ex. GET /api/orders" class="op" aria-label="Opération" />
        </div>
        <div class="find">
          <wl-nav-icon name="timer" [size]="14" class="find-icon" />
          <input [ngModel]="minMs()" (ngModelChange)="minMs.set($event || null)" type="number" min="0" placeholder="Plus lentes que (ms)" class="min" aria-label="Durée minimale" />
        </div>
        <div class="seg">
          <button [class.on]="!errorsOnly()" (click)="errorsOnly.set(false)" title="Toutes les traces de la période"><wl-nav-icon name="list" [size]="13" />Toutes</button>
          <button [class.on]="errorsOnly()" (click)="errorsOnly.set(true)" title="Traces dont au moins un span est en erreur"><i class="dot"></i>En erreur</button>
        </div>
        <span class="spacer"></span>
        <span class="muted small total"><strong class="num" [wlCountUp]="traces().length | num"></strong> trace{{ traces().length > 1 ? 's' : '' }}, plus récentes en premier</span>
      </div>

      <section class="panel">
        @if (traces().length) {
          <table class="list">
            <thead>
              <tr><th class="hide-sm">Début</th><th>Opération</th><th>Service</th><th class="r hide-sm">Spans</th><th class="r">Durée</th><th class="bar-col hide-sm"></th><th class="go"></th></tr>
            </thead>
            <tbody>
              @for (t of traces(); track t.traceId; let i = $index) {
                <tr class="click" [class.cur]="i === cursor()" (click)="open(t)" (mouseenter)="cursor.set(i)">
                  <td class="mono small muted nowrap hide-sm" [title]="fullDate(t.start)">{{ t.start | time: true }}</td>
                  <td class="op-cell">
                    <div class="op-line">
                      @if (operation(t.rootName); as op) {
                        <span class="method" [attr.data-m]="op.method">{{ op.method }}</span>
                        <span class="mono ellipsis op-name" [title]="t.rootName">{{ op.target }}</span>
                      } @else {
                        <span class="mono ellipsis op-name" [title]="t.rootName">{{ t.rootName }}</span>
                      }
                      @if (t.errors) { <span class="tag err">{{ t.errors }} erreur{{ t.errors > 1 ? 's' : '' }}</span> }
                    </div>
                  </td>
                  <td class="nowrap">{{ t.rootService }}@if (t.services > 1) { <span class="more" [title]="t.services + ' services traversés'">+{{ t.services - 1 }}</span> }</td>
                  <td class="r hide-sm">{{ t.spans | num }}</td>
                  <td class="r mono nowrap">{{ t.durationMs | dur }}</td>
                  <td class="bar-col hide-sm">
                    <div class="track" [title]="'Durée relative à la trace la plus longue de la liste'">
                      <div class="bar" [class.err]="t.errors > 0" [style.width.%]="(t.durationMs / maxDuration()) * 100"></div>
                    </div>
                  </td>
                  <td class="go"><wl-nav-icon name="chevron-right" [size]="14" /></td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loading() || loadError()) {
          <div class="empty">
            <p class="lead-text">{{ loadError() || 'Aucune trace sur cette période.' }}</p>
            <p class="hint">
              @if (loadError()) { Vérifiez la connexion au serveur, puis réessayez. }
              @else if (filtered()) { Essayez une autre opération, une durée minimale plus faible ou toutes les traces. }
              @else { Les traces apparaissent dès que vos services envoient des spans (OpenTelemetry). }
            </p>
            <div class="cta">
              @if (loadError()) {
                <button class="btn" (click)="load()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button>
              } @else if (filtered()) {
                <button class="btn" (click)="reset()"><wl-nav-icon name="close" [size]="14" />Effacer les filtres</button>
              }
              @if (!loadError() && canWiden()) {
                <button class="btn ghost" (click)="state.setRelative('24h')"><wl-nav-icon name="calendar" [size]="14" />Élargir à 24 h</button>
              }
            </div>
          </div>
        } @else {
          <wl-skeleton [rows]="8" />
        }
      </section>
      @if (traces().length) {
        <p class="muted small keys"><kbd>↑</kbd> <kbd>↓</kbd> parcourir · <kbd>Entrée</kbd> ouvrir la trace</p>
      }
    </div>
  `,
  styles: `
    .find { position: relative; display: flex; align-items: center; }
    .find-icon { position: absolute; left: 11px; z-index: 1; color: var(--text-3); pointer-events: none; transition: color .25s, transform .4s var(--spring); }
    .find:focus-within .find-icon { color: var(--accent); transform: scale(1.1); }
    .op { width: 270px; padding-left: 33px; }
    .min { width: 175px; padding-left: 33px; }
    .seg button { display: inline-flex; align-items: center; gap: 6px; }
    .seg .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 8px var(--danger); transition: transform .35s var(--spring); }
    .seg button:hover .dot { transform: scale(1.3); }
    .total strong { color: var(--text-1); font-size: 13px; }
    .op-cell { max-width: 0; width: 46%; }
    .op-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .op-name { min-width: 0; transition: color .2s; }
    tr:hover .op-name, tr.cur .op-name { color: var(--accent); }
    .method { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 6px; font: 700 10px/1 var(--mono); letter-spacing: .03em;
      color: var(--m, var(--text-2)); background: color-mix(in srgb, var(--m, var(--text-3)) 14%, transparent); }
    .method[data-m='GET'] { --m: var(--accent); }
    .method[data-m='POST'] { --m: var(--ok); }
    .method[data-m='PUT'] { --m: var(--warn); }
    .method[data-m='PATCH'] { --m: var(--accent-3); }
    .method[data-m='DELETE'] { --m: var(--danger); }
    .tag { flex: none; }
    .more { margin-left: 6px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/16px var(--mono); color: var(--text-2); background: var(--surface-3); }
    .bar-col { width: 18%; min-width: 120px; }
    .track { height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
    .bar { height: 100%; min-width: 3px; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); opacity: .85;
      transform-origin: left; transition: opacity .2s; }
    .bar.err { background: linear-gradient(90deg, color-mix(in srgb, var(--danger) 70%, var(--crash)), var(--danger)); }
    tr:hover .bar { opacity: 1; }
    tbody tr:nth-child(-n+12) .bar { animation: grow .7s var(--ease) .1s backwards; }
    @keyframes grow { from { transform: scaleX(0); } }
    .go { width: 28px; padding-left: 0 !important; color: var(--text-3); }
    .go wl-nav-icon { opacity: .35; transition: transform .35s var(--spring), opacity .2s, color .2s; }
    tr:hover .go wl-nav-icon, tr.cur .go wl-nav-icon { opacity: 1; color: var(--accent); transform: translateX(3px); }
    tr.cur td { background: var(--row-hover); }
    tr.cur td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    .empty .lead-text { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 550; }
    .empty .hint { max-width: 460px; margin: 6px auto 0; font-size: 12.5px; }
    .cta { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .cta:empty { display: none; }
    .keys { margin: 0; }
  `,
})
export class TracesPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly state = inject(AppState);
  /** Paramètre d'URL (recherche globale). */
  readonly q = input<string>('');

  protected readonly traces = signal<TraceSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly text = signal('');
  protected readonly minMs = signal<number | null>(null);
  protected readonly errorsOnly = signal(false);
  /** Ligne choisie au clavier (ou survolée). */
  protected readonly cursor = signal(-1);
  private readonly appliedText = signal('');
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private sub?: Subscription;

  protected readonly maxDuration = computed(() => Math.max(1, ...this.traces().map((t) => t.durationMs)));
  protected readonly filtered = computed(() => !!(this.text() || this.minMs() || this.errorsOnly()));
  /** Période relative de moins de 24 h : on propose de l'élargir. */
  protected readonly canWiden = computed(() => this.state.isRelative() && ['5m', '15m', '1h', '6h'].includes(this.state.from()));

  constructor() {
    effect(() => {
      const q = this.q();
      untracked(() => {
        this.text.set(q ?? '');
        this.appliedText.set((q ?? '').trim());
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      this.appliedText();
      this.minMs();
      this.errorsOnly();
      untracked(() => this.load());
    });
  }

  protected typed(value: string) {
    this.text.set(value);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.appliedText.set(value.trim()), 300);
  }

  protected reset() {
    this.text.set('');
    this.appliedText.set('');
    this.minMs.set(null);
    this.errorsOnly.set(false);
  }

  protected load() {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.sub = this.api
      .traces(this.state.range(), { service: this.state.service(), q: this.appliedText(), minMs: this.minMs(), errors: this.errorsOnly() })
      .subscribe({
        next: (t) => {
          this.traces.set(t);
          this.loadError.set('');
          this.loading.set(false);
          if (this.cursor() >= t.length) this.cursor.set(t.length - 1);
        },
        error: () => {
          this.loading.set(false);
          this.loadError.set('Impossible de charger les traces.');
        },
      });
  }

  open(t: TraceSummary) {
    this.router.navigate(['/traces', t.traceId], { queryParams: { around: t.start } });
  }

  /** Méthode et cible d'une opération HTTP, sinon null. */
  protected operation(name: string) {
    const m = HTTP_OPERATION.exec(name);
    return m ? { method: m[1], target: m[2] } : null;
  }

  /** Date et heure complètes, en infobulle des heures abrégées. */
  protected fullDate(iso: string) {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
  }

  /** ↑ ↓ (ou j k) : parcourir ; Entrée : ouvrir la trace. */
  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const list = this.traces();
    if (!list.length) return;
    const i = this.cursor();
    if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      const next = Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)));
      this.cursor.set(next);
      this.host.querySelectorAll('tbody tr')[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && list[i] && !target.closest('button, a')) {
      this.open(list[i]);
    }
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
    if (this.typingTimer) clearTimeout(this.typingTimer);
  }
}
