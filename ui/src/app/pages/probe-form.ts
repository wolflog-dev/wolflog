import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, Probe, ProbeResult } from '../core/api';
import { DurPipe } from '../core/format';

const INTERVALS = [
  { value: 30, label: 'toutes les 30 secondes' }, { value: 60, label: 'chaque minute' }, { value: 300, label: 'toutes les 5 minutes' }, { value: 900, label: 'toutes les 15 minutes' },
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
  imports: [FormsModule, RouterLink, DurPipe],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/uptime" class="small">Disponibilité</a>
        <span class="muted">/</span>
        <h1>{{ p().id ? 'Modifier la sonde' : 'Nouvelle sonde' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/uptime">Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">{{ p().id ? 'Enregistrer' : 'Créer la sonde' }}</button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Que vérifier ?</h2></div>
            <div class="step-body">
              <div class="choices two">
                <button type="button" class="choice" [class.on]="p().type === 'http'" (click)="patch({ type: 'http', target: p().target.includes('://') ? p().target : 'https://' })">
                  <strong>Une adresse web (HTTP/HTTPS)</strong><span>Page, API ou point de santé : code de réponse, texte attendu, certificat TLS</span>
                </button>
                <button type="button" class="choice" [class.on]="p().type === 'tcp'" (click)="patch({ type: 'tcp', target: '' })">
                  <strong>Un port TCP</strong><span>Base de données, cache, SMTP… : le port accepte-t-il les connexions ?</span>
                </button>
              </div>
              <label class="field">{{ p().type === 'tcp' ? 'Hôte et port' : 'Adresse' }}
                <span class="row">
                  <input class="mono grow" [ngModel]="p().target" (ngModelChange)="patch({ target: $event })"
                         [placeholder]="p().type === 'tcp' ? 'db.interne:5432' : 'https://app.mondomaine.fr/health'" />
                  <button type="button" class="btn" (click)="runTest()" [disabled]="testing()">{{ testing() ? 'Test…' : 'Tester' }}</button>
                </span>
              </label>
              @if (test(); as t) {
                <div class="test" [class.ko]="!t.ok">
                  @if (t.ok) { Répond en {{ t.durationMs | dur }}{{ t.status ? ', code ' + t.status : '' }}{{ t.certificateDays !== null ? ', certificat valide encore ' + t.certificateDays + ' jours' : '' }}. }
                  @else { Échec : {{ t.error }} ({{ t.durationMs | dur }}). }
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
                  @for (i of intervals; track i.value) { <option [value]="i.value">{{ i.label }}</option> }
                </select>
                <span>; considérer en panne après</span>
                <select [ngModel]="p().failuresBeforeDown" (ngModelChange)="patch({ failuresBeforeDown: +$event })">
                  <option [value]="1">1 échec</option><option [value]="2">2 échecs</option><option [value]="3">3 échecs</option><option [value]="5">5 échecs</option>
                </select>
                <span>d'affilée ; délai maximum de réponse</span>
                <span class="unit-input"><input type="number" class="num-in" min="1" max="120" [ngModel]="p().timeoutSeconds" (ngModelChange)="patch({ timeoutSeconds: +$event })" /><em>s</em></span>
              </div>
              <p class="muted small">Deux échecs d'affilée évitent une alerte pour une coupure de quelques secondes.</p>
            </div>
          </section>

          @if (p().type === 'http') {
            <section class="panel step done">
              <div class="step-head"><span class="num">3</span><h2>Réponse attendue</h2><span class="hint">les valeurs par défaut conviennent le plus souvent</span></div>
              <div class="step-body">
                <div class="options">
                  <label class="field">Méthode
                    <select [ngModel]="p().method" (ngModelChange)="patch({ method: $event })"><option>GET</option><option>HEAD</option><option>POST</option></select></label>
                  <label class="field">Codes HTTP acceptés <input [ngModel]="p().expectedStatus" (ngModelChange)="patch({ expectedStatus: $event })" placeholder="200-399" />
                    <span class="muted small">Plage ou liste : 200-399, 200,204</span></label>
                  <label class="field wide">Texte qui doit figurer dans la réponse <input [ngModel]="p().expectedText ?? ''" (ngModelChange)="patch({ expectedText: $event || null })" placeholder='facultatif, ex. "status":"ok"' /></label>
                </div>
                <label class="check"><input type="checkbox" [ngModel]="p().ignoreTlsErrors" (ngModelChange)="patch({ ignoreTlsErrors: $event })" /> Accepter un certificat invalide (auto-signé, interne)</label>
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
                    <option value="">aucun</option>
                    @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
                  </select>
                  <span class="muted small">Relie la sonde aux logs et traces du service.</span></label>
              </div>
              @if (!p().id) {
                <label class="check"><input type="checkbox" [(ngModel)]="withAlert" /> Créer l'alerte « {{ p().name || autoName() }} en panne »</label>
              }
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <p class="phrase">Wolflog {{ p().type === 'tcp' ? 'se connectera à' : 'appellera' }} <strong class="mono">{{ p().target || '…' }}</strong>
              {{ intervalLabel() }} et la considérera en panne après {{ p().failuresBeforeDown }} échec{{ p().failuresBeforeDown > 1 ? 's' : '' }} d'affilée.</p>
            @if (!p().id) { <p class="muted small">{{ withAlert ? 'Une alerte critique sera créée (canaux par défaut).' : 'Aucune alerte ne sera créée.' }}</p> }
          </div>
          <div class="block">
            <h3>Test</h3>
            @if (test(); as t) {
              <span [class.ok]="t.ok" [class.danger]="!t.ok">{{ t.ok ? 'La cible répond.' : 'La cible ne répond pas : ' + t.error }}</span>
            } @else {
              <span class="muted small">« Tester » vérifie l'adresse tout de suite, sans rien enregistrer.</span>
            }
          </div>
          @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy()">{{ p().id ? 'Enregistrer' : 'Créer la sonde' }}</button>
            <a class="btn" routerLink="/uptime">Annuler</a>
            <span class="spacer"></span>
            @if (p().id) { <button class="btn ghost" (click)="remove()">Supprimer</button> }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .row { display: flex; gap: 8px; }
    .grow { flex: 1; }
    .num-in { width: 80px; }
    .unit-input { display: inline-flex; align-items: center; gap: 6px; }
    .unit-input em { font-style: normal; color: var(--text-2); }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 220px; }
    .options .field.wide { flex: 1; min-width: 300px; }
    label.check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-1); cursor: pointer; }
    .test { padding: 8px 10px; border: 1px solid var(--ok); border-radius: var(--radius); font-size: 12.5px; }
    .test.ko { border-color: var(--danger); color: var(--danger); }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    p { margin: 0; }
  `,
})
export class ProbeFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  /** /uptime/:id/edit ; /uptime/new?target=… */
  readonly id = input<string>('');
  readonly target = input<string>('');

  protected readonly p = signal<Probe>(blankProbe());
  protected readonly test = signal<ProbeResult | null>(null);
  protected readonly testing = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly services = signal<string[]>([]);
  protected readonly intervals = INTERVALS;
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
    this.testing.set(true);
    this.error.set('');
    const p = this.p();
    // Sans identifiant : essai seul, rien n'est enregistré.
    this.api.testProbe({ ...p, id: '', name: p.name || this.autoName() }).subscribe({
      next: (r) => { this.test.set(r); this.testing.set(false); },
      error: (e) => { this.error.set(e?.error?.error ?? 'Test impossible.'); this.testing.set(false); },
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
            comparison: 'above', threshold: 14, windowMinutes: 5, forMinutes: 0, repeatMinutes: 0, minCount: 0, notifyResolved: true }).subscribe();
        }
        // Premier contrôle immédiat pour ne pas attendre l'intervalle.
        this.api.testProbe(saved).subscribe({ complete: () => this.router.navigate(['/uptime']), error: () => this.router.navigate(['/uptime']) });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
      },
    });
  }

  protected remove() {
    this.api.deleteProbe(this.p().id).subscribe(() => this.router.navigate(['/uptime']));
  }
}
