import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AlertChannel, ChannelType } from '../core/models';
import { Api } from '../core/api';
import { CHANNEL_TYPES } from '../shared/alert-rules';

/** Création ou modification d'un canal de notification : type, destination, test d'envoi. */
@Component({
  selector: 'wl-channel-form',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/alerts" [queryParams]="{ tab: 'channels' }" class="small">Canaux</a>
        <span class="muted">/</span>
        <h1>{{ isNew() ? 'Ajouter un canal' : form().name || 'Canal' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy() || !valid()">{{ isNew() ? 'Ajouter le canal' : 'Enregistrer' }}</button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Où envoyer les alertes ?</h2></div>
            <div class="step-body">
              <div class="choices">
                @for (t of types; track t.value) {
                  <button type="button" class="choice" [class.on]="form().type === t.value" (click)="patch({ type: t.value })">
                    <strong>{{ t.label }}</strong><span>{{ descriptions[t.value] }}</span>
                  </button>
                }
              </div>
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">2</span><h2>{{ form().type === 'email' ? 'Destinataires' : 'Adresse du webhook' }}</h2></div>
            <div class="step-body">
              <label class="field">{{ form().type === 'email' ? 'Adresses e-mail' : 'URL' }}
                <input [ngModel]="form().target" (ngModelChange)="patch({ target: $event })" [placeholder]="type().placeholder" autocomplete="off" />
                <span class="muted small">{{ type().hint }}</span>
              </label>
              @if (form().type === 'email' && smtpMissing()) {
                <p class="warn small">Aucun serveur SMTP n'est configuré : renseignez-le en bas de l'onglet
                  <a routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Canaux</a> pour que les e-mails partent.</p>
              }
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">3</span><h2>Nom</h2></div>
            <div class="step-body">
              <label class="field">Nom <input [ngModel]="form().name" (ngModelChange)="patch({ name: $event })" [placeholder]="namePlaceholder()" autocomplete="off" />
                <span class="muted small">Tel qu'il apparaît au moment de choisir qui prévenir dans une alerte.</span></label>
              <label class="check"><input type="checkbox" [ngModel]="form().default" (ngModelChange)="patch({ default: $event })" /> Cocher ce canal par défaut sur les nouvelles alertes</label>
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <p class="phrase">{{ summary() }}</p>
          </div>
          <div class="block">
            <h3>Essai</h3>
            <p class="muted small">Envoie un message de test avec les réglages ci-contre, sans enregistrer.</p>
            <div><button class="btn" (click)="test()" [disabled]="!form().target.trim()">Envoyer un test</button></div>
            @if (message(); as m) { <p class="small" [class.danger]="m.error" [class.ok]="!m.error">{{ m.text }}</p> }
          </div>
          @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy() || !valid()">{{ isNew() ? 'Ajouter le canal' : 'Enregistrer' }}</button>
            <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Annuler</a>
            <span class="spacer"></span>
            @if (!isNew()) {
              @if (confirmDelete()) {
                <button class="btn danger-btn" (click)="remove()">Confirmer</button>
              } @else {
                <button class="btn ghost" (click)="confirmDelete.set(true)">Supprimer</button>
              }
            }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .phrase { font-size: 13.5px; line-height: 1.5; }
    .warn { color: var(--warn); }
    .danger-btn { color: var(--danger); border-color: var(--danger); }
    .check { display: flex; gap: 8px; align-items: center; font-size: 13px; }
    p { margin: 0; }
  `,
})
export class ChannelFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly id = input<string>();

  protected readonly types = CHANNEL_TYPES;
  protected readonly descriptions: Record<ChannelType, string> = {
    email: 'Un message à une ou plusieurs adresses, via votre serveur SMTP.',
    teams: 'Une carte dans un canal Teams, par un workflow webhook.',
    slack: 'Un message dans un canal Slack, par un « Incoming Webhook ».',
    webhook: 'Un POST JSON vers votre outil (astreinte, ticketing, script).',
  };
  protected readonly form = signal<AlertChannel>({ id: '', name: '', type: 'email', target: '', default: false });
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal<{ text: string; error: boolean } | null>(null);
  protected readonly confirmDelete = signal(false);
  protected readonly smtpMissing = signal(false);

  protected readonly isNew = computed(() => !this.id() || this.id() === 'new');
  protected readonly type = computed(() => CHANNEL_TYPES.find((t) => t.value === this.form().type) ?? CHANNEL_TYPES[0]);
  protected readonly valid = computed(() => !!this.form().target.trim());
  protected readonly namePlaceholder = computed(() => ({ email: 'ex. Astreinte', teams: 'ex. Teams #prod', slack: 'ex. #prod-alertes', webhook: 'ex. PagerDuty' })[this.form().type]);

  protected readonly summary = computed(() => {
    const f = this.form();
    const name = f.name.trim() || this.defaultName();
    const where = f.type === 'email'
      ? `par e-mail à ${f.target.trim() || '…'}`
      : `${f.type === 'webhook' ? 'par webhook' : 'dans ' + this.type().label} (${this.host(f.target) || 'adresse à renseigner'})`;
    return `« ${name} » envoie les alertes ${where}${f.default ? ', coché par défaut sur les nouvelles alertes' : ''}.`;
  });

  constructor() {
    queueMicrotask(() => {
      if (this.isNew()) {
        this.api.channels().subscribe((c) => this.patch({ default: c.length === 0 }));
      } else {
        this.api.channels().subscribe((c) => {
          const found = c.find((x) => x.id === this.id());
          if (found) this.form.set({ ...found });
          else this.router.navigate(['/alerts'], { queryParams: { tab: 'channels' }, replaceUrl: true });
        });
      }
    });
    this.api.notificationSettings().subscribe({ next: (s) => this.smtpMissing.set(!s.smtpHost), error: () => {} });
  }

  protected patch(change: Partial<AlertChannel>) {
    this.form.update((f) => ({ ...f, ...change }));
    this.message.set(null);
  }

  private defaultName() {
    const f = this.form();
    return f.type === 'email' ? (f.target.split(',')[0]?.trim() || 'E-mail') : this.type().label;
  }

  private host(url: string) {
    try { return new URL(url.trim()).host; } catch { return url.trim(); }
  }

  protected test() {
    this.message.set({ text: 'Envoi…', error: false });
    const f = this.form();
    this.api.testChannel({ ...f, name: f.name.trim() || this.defaultName(), target: f.target.trim() }).subscribe({
      next: () => this.message.set({ text: 'Message de test envoyé.', error: false }),
      error: (e) => this.message.set({ text: e?.error?.error ?? 'Échec de l’envoi.', error: true }),
    });
  }

  protected save() {
    const f = this.form();
    this.busy.set(true);
    this.error.set('');
    this.api.saveChannel({ ...f, name: f.name.trim() || this.defaultName(), target: f.target.trim() }).subscribe({
      next: () => this.router.navigate(['/alerts'], { queryParams: { tab: 'channels' } }),
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
      },
    });
  }

  protected remove() {
    this.api.deleteChannel(this.form().id).subscribe(() => this.router.navigate(['/alerts'], { queryParams: { tab: 'channels' } }));
  }
}
