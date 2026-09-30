import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { Api } from '../core/api';
import { AlertChannel, AlertRule, MessagePreviewResult } from '../core/models';
import { MessageEditor } from './message-editor';

/**
 * Personnalisation du message d'une alerte (ou du modèle par défaut) : titre et message dans l'éditeur visuel,
 * aperçu fidèle Teams / Slack / e-mail calculé par le serveur avec les données actuelles de la règle, envoi de test.
 */
@Component({
  selector: 'wl-message-composer',
  imports: [MessageEditor],
  template: `
    <div class="composer">
      @if (mode() === 'rule' && !custom()) {
        <div class="default-row">
          <span class="muted small">Message par défaut{{ isAdminHint() }}.</span>
          <button type="button" class="btn small" (click)="customize()">Personnaliser le message</button>
        </div>
      } @else {
        <div class="fields">
          <label class="lbl">Titre</label>
          <wl-message-editor [value]="titleValue()" (valueChange)="setTitle($event)" [variables]="variables()" [singleLine]="true"
                             label="Titre de la notification" placeholder="Titre de la notification" />
          <label class="lbl">Message</label>
          <wl-message-editor [value]="bodyValue()" (valueChange)="setBody($event)" [variables]="variables()"
                             label="Message de la notification" placeholder="Écrivez le message ; « + Information » pour insérer une donnée." />
          <div class="actions-row">
            <span class="muted small">Une ligne dont toutes les informations sont vides n'est pas envoyée.</span>
            <span class="spacer"></span>
            <button type="button" class="btn ghost small" (click)="reset()">{{ mode() === 'rule' ? 'Revenir au message par défaut' : 'Rétablir le modèle intégré' }}</button>
          </div>
        </div>
      }

      <div class="preview">
        <div class="preview-head">
          <div class="tabs">
            @for (t of tabs; track t.value) {
              <button type="button" [class.on]="tab() === t.value" (click)="tab.set(t.value)">{{ t.label }}</button>
            }
          </div>
          <span class="spacer"></span>
          @if (result(); as r) {
            <span class="muted small">{{ r.sample ? 'Valeurs d’exemple' : 'Données actuelles de la règle' }}</span>
          }
        </div>

        @if (error()) {
          <div class="danger small pad">{{ error() }}</div>
        } @else if (result(); as r) {
          @switch (tab()) {
            @case ('teams') {
              <div class="teams" [attr.data-tone]="r.preview.tone">
                <div class="t-app"><span class="logo">W</span><strong>Wolflog</strong><span class="muted">via Workflows</span></div>
                <div class="t-card">
                  <div class="t-title">{{ r.preview.title }}</div>
                  <div class="rich" [innerHTML]="r.preview.html"></div>
                  @if (r.preview.link) { <span class="t-btn">Voir dans Wolflog</span> }
                </div>
              </div>
            }
            @case ('slack') {
              <div class="slack">
                <span class="s-avatar">W</span>
                <div>
                  <div class="s-head"><strong>Wolflog</strong><span class="s-app">APP</span></div>
                  <div class="s-title">{{ r.preview.title }}</div>
                  <div class="rich" [innerHTML]="r.preview.html"></div>
                  @if (r.preview.link) { <a class="s-link">Voir dans Wolflog</a> }
                </div>
              </div>
            }
            @default {
              <div class="mail">
                <div class="m-head">
                  <div><span class="muted">De</span> Wolflog</div>
                  <div><span class="muted">Objet</span> <strong>[Wolflog] {{ r.preview.title }}</strong></div>
                </div>
                <div class="m-body">
                  <div class="m-title">{{ r.preview.title }}</div>
                  <div class="rich" [innerHTML]="r.preview.html"></div>
                  @if (r.preview.link) { <a class="m-link">Voir dans Wolflog</a> }
                </div>
              </div>
            }
          }
        } @else {
          <div class="muted small pad">Calcul de l’aperçu…</div>
        }

        <div class="test-row">
          @if (mode() === 'default') {
            <select [value]="testChannel()" (change)="testChannel.set($any($event.target).value)" aria-label="Canal de test">
              <option value="">Canal de test…</option>
              @for (c of channels(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
            </select>
          }
          <button type="button" class="btn small" (click)="sendTest()" [disabled]="testing() || !canTest()">
            {{ testing() ? 'Envoi…' : 'Envoyer un test' }}
          </button>
          @if (testResult(); as t) { <span class="small" [class.ok]="t.ok" [class.danger]="!t.ok">{{ t.text }}</span> }
          @else if (!canTest()) { <span class="muted small">{{ mode() === 'rule' ? 'Cochez un canal pour envoyer un test.' : '' }}</span> }
        </div>
      </div>
    </div>
  `,
  styles: `
    .composer { display: grid; gap: 14px; }
    .default-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .fields { display: grid; gap: 6px; }
    .lbl { font-size: 12px; color: var(--text-2); margin-top: 4px; }
    .actions-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .preview { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); overflow: hidden; }
    .preview-head { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
    .tabs { display: flex; gap: 2px; }
    .tabs button { height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--text-3); font: 500 12.5px var(--sans); cursor: pointer; }
    .tabs button.on { background: var(--surface); color: var(--text-1); box-shadow: 0 1px 2px rgba(0, 0, 0, .15); }
    .pad { padding: 16px; }
    .rich { font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; }
    .rich :is(p) { margin: 0 0 4px; }
    .rich :is(ul) { margin: 2px 0 6px; padding-left: 20px; }
    .rich a { color: #4f8ef7; }

    /* Teams */
    .teams { padding: 16px; background: #f5f5f5; color: #242424; font-family: 'Segoe UI', system-ui, sans-serif; animation: fade .25s ease-out; }
    .t-app { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 6px; }
    .t-app .muted { color: #616161; }
    .logo, .s-avatar { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: #1d2026; color: #fff; font: 700 12px var(--sans); }
    .t-card { max-width: 520px; padding: 14px 16px; border-radius: 6px; background: #fff; border-left: 4px solid #c4314b; box-shadow: 0 1px 3px rgba(0, 0, 0, .12); }
    .teams[data-tone='Warning'] .t-card { border-left-color: #c19c00; }
    .teams[data-tone='Good'] .t-card { border-left-color: #237b4b; }
    .t-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; color: #c4314b; }
    .teams[data-tone='Warning'] .t-title { color: #8a6d00; }
    .teams[data-tone='Good'] .t-title { color: #237b4b; }
    .t-btn { display: inline-block; margin-top: 10px; padding: 5px 12px; border: 1px solid #d1d1d1; border-radius: 4px; font-size: 13px; font-weight: 600; color: #242424; }

    /* Slack */
    .slack { display: flex; gap: 10px; padding: 16px; background: #fff; color: #1d1c1d; font-family: 'Lato', 'Segoe UI', system-ui, sans-serif; animation: fade .25s ease-out; }
    .s-avatar { width: 36px; height: 36px; border-radius: 8px; flex: none; }
    .s-head { display: flex; align-items: center; gap: 6px; font-size: 14px; }
    .s-app { padding: 0 4px; border-radius: 3px; background: #e8e8e8; color: #616061; font-size: 10px; font-weight: 700; }
    .s-title { font-weight: 700; margin: 2px 0; }
    .s-link { color: #1264a3; font-size: 14px; }

    /* E-mail */
    .mail { background: #fff; color: #1d2026; animation: fade .25s ease-out; }
    .m-head { display: grid; gap: 2px; padding: 10px 16px; border-bottom: 1px solid #e6e6e6; font-size: 12.5px; }
    .m-head .muted { display: inline-block; width: 44px; color: #858b96; }
    .m-body { padding: 16px; font: 14px/1.5 'Segoe UI', Arial, sans-serif; }
    .m-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    .m-link { display: inline-block; margin-top: 10px; color: #2f5fd0; }

    .test-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px; border-top: 1px solid var(--border); background: var(--surface); }
    @keyframes fade { from { opacity: .4; } }
    @media (prefers-reduced-motion: reduce) { .teams, .slack, .mail { animation: none; } }
  `,
})
export class MessageComposer {
  private readonly api = inject(Api);

  /** rule : message d'une règle (vide = modèle par défaut) ; default : modèle par défaut de toutes les règles. */
  readonly mode = input<'rule' | 'default'>('rule');
  readonly rule = input<AlertRule | null>(null);
  readonly title = input<string | null>(null);
  readonly body = input<string | null>(null);
  readonly channels = input<AlertChannel[]>([]);
  readonly titleChange = output<string | null>();
  readonly bodyChange = output<string | null>();

  protected readonly tabs = [
    { value: 'teams', label: 'Teams' },
    { value: 'slack', label: 'Slack' },
    { value: 'email', label: 'E-mail' },
  ] as const;
  protected readonly tab = signal<'teams' | 'slack' | 'email'>('teams');
  protected readonly result = signal<MessagePreviewResult | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly testChannel = signal('');

  /**
   * Valeurs affichées dans les éditeurs : le modèle saisi ; avant toute saisie, le modèle en vigueur.
   * Une fois l'édition commencée, un champ vidé reste vide (il ne se remplit plus avec le modèle par défaut).
   */
  private readonly editing = signal(false);
  protected readonly custom = computed(() => this.editing() || !!(this.title() || this.body()));
  protected readonly titleValue = computed(() => this.title() ?? (this.editing() ? '' : this.result()?.titleTemplate ?? ''));
  protected readonly bodyValue = computed(() => this.body() ?? (this.editing() ? '' : this.result()?.bodyTemplate ?? ''));
  protected readonly variables = computed(() => this.result()?.variables ?? []);
  protected readonly canTest = computed(() => (this.mode() === 'rule' ? (this.rule()?.channels.length ?? 0) > 0 : !!this.testChannel()));

  private readonly requests = new Subject<void>();

  constructor() {
    this.requests.pipe(
      debounceTime(350),
      switchMap(() => this.api.messagePreview(this.input()).pipe(catchError((e) => {
        this.error.set(e?.error?.error ?? 'Aperçu impossible.');
        return of(null);
      }))),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe((r) => {
      if (!r) return;
      this.error.set(null);
      this.result.set(r);
    });
    effect(() => {
      this.rule();
      this.title();
      this.body();
      untracked(() => this.requests.next());
    });
  }

  protected isAdminHint() {
    return this.mode() === 'rule' ? ' (modifiable par un administrateur dans Alertes > Canaux)' : '';
  }

  private input() {
    return { rule: this.rule(), title: this.title() || null, body: this.body() || null };
  }

  protected customize() {
    this.editing.set(true);
    const r = this.result();
    this.titleChange.emit(r?.titleTemplate ?? '{{statut}} : {{regle}}');
    this.bodyChange.emit(r?.bodyTemplate ?? '{{message}}');
  }

  protected reset() {
    this.editing.set(false);
    this.titleChange.emit(null);
    this.bodyChange.emit(null);
  }

  protected setTitle(v: string) {
    this.editing.set(true);
    this.titleChange.emit(v.trim() ? v : null);
  }

  protected setBody(v: string) {
    this.editing.set(true);
    this.bodyChange.emit(v.trim() ? v : null);
  }

  protected sendTest() {
    this.testing.set(true);
    this.testResult.set(null);
    const channels = this.mode() === 'default' ? [this.testChannel()] : null;
    this.api.messageTest({ ...this.input(), channels }).subscribe({
      next: (r) => {
        this.testing.set(false);
        this.testResult.set({ ok: true, text: `Envoyé à ${r.sent.join(', ')}.` });
      },
      error: (e) => {
        this.testing.set(false);
        this.testResult.set({ ok: false, text: e?.error?.error ?? 'Envoi impossible.' });
      },
    });
  }
}
