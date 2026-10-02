import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Probe, ProbeResult } from '../core/models';
import { Toasts } from '../core/toasts';
import { DurPipe } from '../core/pipes/dur-pipe';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';

const INTERVALS = [
  { value: 30, label: 'toutes les 30 secondes', desc: 'Détection la plus rapide' },
  { value: 60, label: 'chaque minute', desc: 'Le bon compromis' },
  { value: 300, label: 'toutes les 5 minutes', desc: 'Économe, pour les services secondaires' },
  { value: 900, label: 'toutes les 15 minutes', desc: 'Contrôle de fond' },
];

/** Échecs d'affilée avant de déclarer la cible en panne. */
const FAILURES = [
  { value: 1, label: '1 échec', desc: 'Alerte dès la première erreur' },
  { value: 2, label: '2 échecs', desc: 'Ignore une coupure de quelques secondes' },
  { value: 3, label: '3 échecs', desc: 'Tolérant' },
  { value: 5, label: '5 échecs', desc: 'Très tolérant' },
];

/** Méthodes HTTP proposées pour l'appel. */
const METHODS = [
  { value: 'GET', icon: 'download', desc: 'Lecture simple : le choix courant' },
  { value: 'HEAD', icon: 'eye', desc: 'En-têtes seulement, plus léger' },
  { value: 'POST', icon: 'arrow-up', desc: 'Envoi d’une requête vide' },
];

function blankProbe(): Probe {
  return {
    id: '', name: '', enabled: true, type: 'http', target: 'https://', method: 'GET', intervalSeconds: 60, timeoutSeconds: 10,
    expectedStatus: '200-399', expectedText: null, failuresBeforeDown: 2, service: null, ignoreTlsErrors: false,
  };
}

/** Création / modification d'une sonde : adresse testée tout de suite, puis fréquence, réponse attendue, nom. */
@Component({
  selector: 'wl-probe-form',
  imports: [FormsModule, RouterLink, DurPipe, NavIcon, RichOption],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/uptime" class="small crumb"><wl-nav-icon name="uptime" [size]="14" />Disponibilité</a>
        <span class="muted">/</span>
        <h1>{{ p().id ? 'Modifier la sonde' : 'Nouvelle sonde' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/uptime"><wl-nav-icon name="close" [size]="15" />Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">
          @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="p().id ? 'check' : 'plus'" [size]="15" /> }
          {{ p().id ? 'Enregistrer' : 'Créer la sonde' }}
        </button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Que vérifier ?</h2></div>
            <div class="step-body">
              <div class="choices two">
                <button type="button" class="choice kind" [class.on]="p().type === 'http'" (click)="patch({ type: 'http', target: p().target.includes('://') ? p().target : 'https://' })">
                  <span class="k-icon"><wl-nav-icon name="globe" [size]="17" /></span>
                  <strong>Une adresse web (HTTP/HTTPS)</strong><span class="k-hint">Page, API ou point de santé : code de réponse, texte attendu, certificat TLS</span>
                </button>
                <button type="button" class="choice kind" [class.on]="p().type === 'tcp'" (click)="patch({ type: 'tcp', target: '' })">
                  <span class="k-icon"><wl-nav-icon name="server" [size]="17" /></span>
                  <strong>Un port TCP</strong><span class="k-hint">Base de données, cache, SMTP… : le port accepte-t-il les connexions ?</span>
                </button>
              </div>
              <label class="field">{{ p().type === 'tcp' ? 'Hôte et port' : 'Adresse' }}
                <span class="row">
                  <span class="target grow">
                    <span class="t-icon"><wl-nav-icon [name]="p().type === 'tcp' ? 'server' : 'link'" [size]="15" /></span>
                    <input class="mono" [ngModel]="p().target" (ngModelChange)="patch({ target: $event })" (keydown.enter)="runTest()"
                           [placeholder]="p().type === 'tcp' ? 'db.interne:5432' : 'https://app.mondomaine.fr/health'" />
                  </span>
                  <button type="button" class="btn" (click)="runTest()" [disabled]="testing()" title="Vérifier l'adresse maintenant, sans rien enregistrer (Entrée)">
                    @if (testing()) { <span class="spinner"></span> } @else { <wl-nav-icon name="play" [size]="13" /> }
                    {{ testing() ? 'Test…' : 'Tester' }}
                  </button>
                </span>
              </label>
              @if (test(); as t) {
                <div class="test" [class.ko]="!t.ok" [class.stale]="testing()" animate.enter="test-in">
                  <span class="t-badge"><wl-nav-icon [name]="t.ok ? 'ok' : 'warning'" [size]="18" /></span>
                  <div class="t-body">
                    @if (t.ok) {
                      <strong>Répond en {{ t.durationMs | dur }}</strong>
                      <div class="t-facts">
                        @if (t.status) { <span><wl-nav-icon name="hash" [size]="12" />code {{ t.status }}</span> }
                        @if (t.certificateDays !== null) {
                          <span [class.warn]="t.certificateDays < 30"><wl-nav-icon name="lock" [size]="12" />certificat valide encore {{ t.certificateDays }} jours</span>
                        }
                      </div>
                    } @else {
                      <strong>Échec du test</strong>
                      <span class="t-err">{{ t.error }} ({{ t.durationMs | dur }}).</span>
                    }
                  </div>
                </div>
              }
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">2</span><h2>À quelle fréquence ?</h2></div>
            <div class="step-body">
              <div class="sentence">
                <span>Vérifier</span>
                <select [ngModel]="p().intervalSeconds" (ngModelChange)="patch({ intervalSeconds: +$event })">
                  @for (i of intervals; track i.value) { <option [value]="i.value" [wlOpt]="i.label" icon="clock" [desc]="i.desc"></option> }
                </select>
                <span>; considérer en panne après</span>
                <select [ngModel]="p().failuresBeforeDown" (ngModelChange)="patch({ failuresBeforeDown: +$event })">
                  @for (f of failures; track f.value) { <option [value]="f.value" [wlOpt]="f.label" icon="warning" tone="warn" [desc]="f.desc"></option> }
                </select>
                <span>d'affilée ; délai maximum de réponse</span>
                <span class="unit-input"><input type="number" class="num-in" min="1" max="120" [ngModel]="p().timeoutSeconds" (ngModelChange)="patch({ timeoutSeconds: +$event })" /><em>s</em></span>
              </div>
              <p class="note"><wl-nav-icon name="info" [size]="14" />Deux échecs d'affilée évitent une alerte pour une coupure de quelques secondes.</p>
            </div>
          </section>

          @if (p().type === 'http') {
            <section class="panel step done" animate.enter="step-in">
              <div class="step-head"><span class="num">3</span><h2>Réponse attendue</h2><span class="hint">les valeurs par défaut conviennent le plus souvent</span></div>
              <div class="step-body">
                <div class="options">
                  <label class="field">Méthode
                    <select [ngModel]="p().method" (ngModelChange)="patch({ method: $event })">
                      @for (m of methods; track m.value) { <option [value]="m.value" [wlOpt]="m.value" [icon]="m.icon" [desc]="m.desc"></option> }
                    </select></label>
                  <label class="field">Codes HTTP acceptés <input [ngModel]="p().expectedStatus" (ngModelChange)="patch({ expectedStatus: $event })" placeholder="200-399" />
                    <span class="muted small">Plage ou liste : 200-399, 200,204</span></label>
                  <label class="field wide">Texte qui doit figurer dans la réponse <input [ngModel]="p().expectedText ?? ''" (ngModelChange)="patch({ expectedText: $event || null })" placeholder='facultatif, ex. "status":"ok"' /></label>
                </div>
                <label class="check"><input type="checkbox" class="switch" [ngModel]="p().ignoreTlsErrors" (ngModelChange)="patch({ ignoreTlsErrors: $event })" /> Accepter un certificat invalide (auto-signé, interne)</label>
              </div>
            </section>
          }

          <section class="panel step done">
            <div class="step-head"><span class="num">{{ p().type === 'http' ? 4 : 3 }}</span><h2>Nom et suivi</h2></div>
            <div class="step-body">
              <div class="options">
                <label class="field">Nom <input [ngModel]="p().name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></label>
                <label class="field">Service associé
                  <select [ngModel]="p().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                    <option value="" wlOpt="aucun" icon="close" tone="muted" desc="Sonde indépendante"></option>
                    @for (s of services(); track s) { <option [value]="s" [wlOpt]="s" avatar></option> }
                  </select>
                  <span class="muted small">Relie la sonde aux logs et traces du service.</span></label>
              </div>
              @if (!p().id) {
                <label class="check"><input type="checkbox" class="switch" [(ngModel)]="withAlert" /> Créer l'alerte « {{ p().name || autoName() }} en panne »</label>
              }
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <div class="sum">
              <span class="sum-icon"><wl-nav-icon [name]="p().type === 'tcp' ? 'server' : 'globe'" [size]="18" /></span>
              <p class="phrase">Wolflog {{ p().type === 'tcp' ? 'se connectera à' : 'appellera' }} <strong class="mono target-text">{{ p().target || '…' }}</strong>
                {{ intervalLabel() }} et la considérera en panne après {{ p().failuresBeforeDown }} échec{{ p().failuresBeforeDown > 1 ? 's' : '' }} d'affilée.</p>
            </div>
            @if (!p().id) {
              <p class="muted small with-icon"><wl-nav-icon [name]="withAlert ? 'bell' : 'mute'" [size]="13" />{{ withAlert ? 'Une alerte critique sera créée (canaux par défaut).' : 'Aucune alerte ne sera créée.' }}</p>
            }
          </div>
          <div class="block">
            <h3>Test</h3>
            @if (test(); as t) {
              <span class="verdict" [class.ko]="!t.ok"><wl-nav-icon [name]="t.ok ? 'ok' : 'warning'" [size]="15" /><span>{{ t.ok ? 'La cible répond.' : 'La cible ne répond pas : ' + t.error }}</span></span>
            } @else {
              <span class="muted small">« Tester » vérifie l'adresse tout de suite, sans rien enregistrer.</span>
            }
          </div>
          @if (error()) { <div class="block"><span class="danger small err" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy()">
              @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="p().id ? 'check' : 'plus'" [size]="15" /> }
              {{ p().id ? 'Enregistrer' : 'Créer la sonde' }}
            </button>
            <a class="btn" routerLink="/uptime">Annuler</a>
            <span class="spacer"></span>
            @if (p().id) {
              @if (confirmDelete()) {
                <span class="confirm" animate.enter="confirm-in">
                  <button class="btn danger-btn" (click)="remove()" [disabled]="deleting()"><wl-nav-icon name="trash" [size]="14" />Confirmer</button>
                  <button class="btn ghost icon" (click)="confirmDelete.set(false)" title="Ne pas supprimer" aria-label="Ne pas supprimer"><wl-nav-icon name="close" [size]="14" /></button>
                </span>
              } @else {
                <button class="btn ghost del" (click)="confirmDelete.set(true)"><wl-nav-icon name="trash" [size]="14" />Supprimer</button>
              }
            }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .crumb { display: inline-flex; align-items: center; gap: 6px; }
    .crumb wl-nav-icon { transition: transform .35s var(--spring); }
    .crumb:hover wl-nav-icon { transform: translateX(-2px) rotate(-10deg); }

    /* Type de sonde : carte avec icône qui pivote au survol et se remplit une fois choisie. */
    .choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .choice.kind { grid-template-columns: 34px minmax(0, 1fr); column-gap: 12px; row-gap: 2px; align-items: center; }
    .kind .k-icon { grid-row: span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: var(--accent);
      background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
      transition: transform .4s var(--spring), color .25s, background-color .25s; }
    .kind:hover .k-icon { transform: scale(1.1) rotate(-8deg); }
    .kind.on .k-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 16px -8px var(--accent);
      animation: icon-pop .5s var(--spring); }
    @keyframes icon-pop { 40% { transform: scale(1.18) rotate(-10deg); } }

    /* Adresse : icône dans le champ ; résultat du test en carte. */
    .row { display: flex; gap: 8px; }
    .grow { flex: 1; min-width: 0; }
    .target { position: relative; display: block; }
    .target input { width: 100%; padding-left: 36px; }
    .t-icon { position: absolute; left: 11px; top: 50%; z-index: 1; display: grid; color: var(--text-3); pointer-events: none; transform: translateY(-50%); transition: color .25s; }
    .target:focus-within .t-icon { color: var(--accent); }
    .test { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 12.5px;
      border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); transition: opacity .2s; }
    .test.ko { border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); }
    .test.stale { opacity: .5; }
    .test-in { animation: test-in .45s var(--spring); }
    @keyframes test-in { from { opacity: 0; transform: translateY(-4px) scale(.97); } }
    .t-badge { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 50%; color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
    .test.ko .t-badge { color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }
    .t-body { display: grid; gap: 4px; min-width: 0; }
    .t-body strong { font-size: 13px; }
    .test.ko strong, .t-err { color: var(--danger); overflow-wrap: anywhere; }
    .t-facts { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--text-2); }
    .t-facts span { display: inline-flex; align-items: center; gap: 5px; }
    .t-facts wl-nav-icon { color: var(--text-3); }
    .warn, .t-facts .warn wl-nav-icon { color: var(--warn); }

    .num-in { width: 80px; }
    .unit-input { display: inline-flex; align-items: center; gap: 6px; }
    .unit-input em { font-style: normal; color: var(--text-2); }
    .note { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-3); }
    .note wl-nav-icon { color: var(--accent); }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 220px; }
    .options .field.wide { flex: 1; min-width: 300px; }
    label.check { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-1); cursor: pointer; }
    .step-in { animation: step-in .4s var(--ease) backwards; }
    @keyframes step-in { from { opacity: 0; transform: translateY(-6px); } }

    /* Résumé. */
    .sum { display: flex; align-items: flex-start; gap: 12px; }
    .sum-icon { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 11px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -10px var(--accent); }
    .phrase { font-size: 13.5px; line-height: 1.5; min-width: 0; }
    .target-text { overflow-wrap: anywhere; }
    .with-icon { display: flex; align-items: center; gap: 6px; }
    .verdict { display: flex; align-items: flex-start; gap: 6px; color: var(--ok); font-weight: 600; overflow-wrap: anywhere; }
    .verdict wl-nav-icon { margin-top: 1px; }
    .verdict.ko { color: var(--danger); }
    .err { display: inline-flex; align-items: center; gap: 6px; }
    .fade-in { animation: test-in .35s var(--spring); }

    /* Suppression en deux temps, bouton de confirmation rouge. */
    .actions { flex-wrap: wrap; }
    .confirm { display: inline-flex; gap: 4px; margin-left: auto; }
    .confirm-in { animation: confirm-in .35s var(--spring); }
    @keyframes confirm-in { from { opacity: 0; transform: translateX(10px) scale(.94); } }
    .danger-btn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent);
      --ripple: color-mix(in srgb, var(--danger) 45%, transparent); }
    .danger-btn:hover { color: var(--on-accent); background: var(--danger); border-color: var(--danger); }
    .del:hover { color: var(--danger); }
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(1turn); } }
    p { margin: 0; }
  `,
})
export class ProbeFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  /** /uptime/:id/edit ; /uptime/new?target=… */
  readonly id = input<string>('');
  readonly target = input<string>('');

  protected readonly p = signal<Probe>(blankProbe());
  protected readonly test = signal<ProbeResult | null>(null);
  protected readonly testing = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly services = signal<string[]>([]);
  protected readonly confirmDelete = signal(false);
  protected readonly deleting = signal(false);
  protected readonly intervals = INTERVALS;
  protected readonly failures = FAILURES;
  protected readonly methods = METHODS;
  protected withAlert = true;

  protected readonly autoName = computed(() => {
    const t = this.p().target ?? '';
    try {
      if (!t.includes('://')) return t || 'sonde';
      const u = new URL(t);
      return u.host + (u.pathname !== '/' ? u.pathname : '');
    } catch { return t; }
  });
  protected readonly intervalLabel = computed(() => INTERVALS.find((i) => i.value === this.p().intervalSeconds)?.label ?? `toutes les ${this.p().intervalSeconds} s`);

  constructor() {
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
    effect(() => {
      const id = this.id();
      const target = this.target();
      untracked(() => {
        if (id) {
          this.api.probes({ from: '1h', to: '' }, 1).subscribe((l) => {
            const found = l.find((x) => x.probe.id === id)?.probe;
            if (found) this.p.set({ ...found });
            else this.error.set('Sonde introuvable.');
          });
        } else if (target) {
          this.patch({ target });
        }
      });
    });
  }

  protected patch(change: Partial<Probe>) {
    this.p.update((p) => ({ ...p, ...change }));
    if ('target' in change || 'type' in change) this.test.set(null);
  }

  protected runTest() {
    if (this.testing()) return;
    this.testing.set(true);
    this.error.set('');
    const p = this.p();
    // Sans identifiant : essai seul, rien n'est enregistré.
    this.api.testProbe({ ...p, id: '', name: p.name || this.autoName() }).subscribe({
      next: (r) => { this.test.set(r); this.testing.set(false); },
      error: (e) => {
        const message = e?.error?.error ?? 'Test impossible.';
        this.error.set(message);
        this.toasts.error(message);
        this.testing.set(false);
      },
    });
  }

  protected save() {
    this.busy.set(true);
    this.error.set('');
    const p = this.p();
    const isNew = !p.id;
    this.api.saveProbe({ ...p, name: p.name.trim() || this.autoName() }).subscribe({
      next: (saved) => {
        if (isNew && this.withAlert) {
          this.api.saveAlert({ name: `${saved.name} en panne`, kind: 'probe', targetId: saved.id, severity: 'critical', channels: [], enabled: true,
            comparison: 'above', threshold: 14, windowMinutes: 5, forMinutes: 0, repeatMinutes: 0, minCount: 0, notifyResolved: true })
            .subscribe({ error: (e) => this.toasts.error(e?.error?.error ?? 'Sonde créée, mais son alerte n’a pas pu être créée.') });
        }
        this.toasts.ok(isNew ? (this.withAlert ? 'Sonde créée, avec son alerte' : 'Sonde créée') : 'Sonde enregistrée', 'uptime');
        // Premier contrôle immédiat pour ne pas attendre l'intervalle.
        this.api.testProbe(saved).subscribe({ complete: () => this.router.navigate(['/uptime']), error: () => this.router.navigate(['/uptime']) });
      },
      error: (e) => {
        this.busy.set(false);
        const message = e?.error?.error ?? 'Enregistrement impossible.';
        this.error.set(message);
        this.toasts.error(message);
      },
    });
  }

  protected remove() {
    this.deleting.set(true);
    this.api.deleteProbe(this.p().id).subscribe({
      next: () => {
        this.toasts.ok('Sonde supprimée', 'trash');
        this.router.navigate(['/uptime']);
      },
      error: (e) => {
        this.deleting.set(false);
        this.confirmDelete.set(false);
        this.toasts.error(e?.error?.error ?? 'Suppression impossible.');
      },
    });
  }
}
