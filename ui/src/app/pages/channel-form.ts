import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AlertChannel, ChannelType } from '../core/models';
import { Api } from '../core/api';
import { Toasts } from '../core/toasts';
import { CHANNEL_TYPES, channelIcon } from '../shared/alert-rules';
import { NavIcon } from '../shared/nav-icon';

/** Création ou modification d'un canal de notification : type, destination, test d'envoi. */
@Component({
  selector: 'wl-channel-form',
  imports: [FormsModule, RouterLink, NavIcon],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/alerts" [queryParams]="{ tab: 'channels' }" class="small crumb"><wl-nav-icon name="chat" [size]="14" />Canaux</a>
        <span class="muted">/</span>
        <h1>{{ isNew() ? 'Ajouter un canal' : form().name || 'Canal' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'channels' }"><wl-nav-icon name="close" [size]="15" />Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy() || !valid()">
          @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="isNew() ? 'plus' : 'check'" [size]="15" /> }
          {{ isNew() ? 'Ajouter le canal' : 'Enregistrer' }}
        </button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Où envoyer les alertes ?</h2></div>
            <div class="step-body">
              <div class="choices">
                @for (t of types; track t.value) {
                  <button type="button" class="choice kind" [class.on]="form().type === t.value" (click)="patch({ type: t.value })">
                    <span class="k-icon"><wl-nav-icon [name]="t.icon" [size]="17" /></span>
                    <strong>{{ t.label }}</strong><span class="k-hint">{{ descriptions[t.value] }}</span>
                  </button>
                }
              </div>
            </div>
          </section>

          <section class="panel step" [class.done]="valid()">
            <div class="step-head"><span class="num">2</span><h2>{{ form().type === 'email' ? 'Destinataires' : 'Adresse du webhook' }}</h2></div>
            <div class="step-body">
              <label class="field">{{ form().type === 'email' ? 'Adresses e-mail' : 'URL' }}
                <span class="target">
                  <span class="t-icon"><wl-nav-icon [name]="form().type === 'email' ? 'mail' : 'link'" [size]="15" /></span>
                  <input [ngModel]="form().target" (ngModelChange)="patch({ target: $event })" [placeholder]="type().placeholder" autocomplete="off" />
                </span>
                <span class="muted small">{{ type().hint }}</span>
              </label>
              @if (targetCheck(); as c) {
                <p class="check-line" [class.ko]="!c.ok" animate.enter="fade-in"><wl-nav-icon [name]="c.ok ? 'ok' : 'warning'" [size]="14" />{{ c.text }}</p>
              }
              @if (form().type === 'email' && smtpMissing()) {
                <p class="callout" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="16" /><span>Aucun serveur SMTP n'est configuré : renseignez-le en bas de l'onglet
                  <a routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Canaux</a> pour que les e-mails partent.</span></p>
              }
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">3</span><h2>Nom</h2></div>
            <div class="step-body">
              <label class="field">Nom <input [ngModel]="form().name" (ngModelChange)="patch({ name: $event })" [placeholder]="namePlaceholder()" autocomplete="off" />
                <span class="muted small">Tel qu'il apparaît au moment de choisir qui prévenir dans une alerte.</span></label>
              <label class="check"><input type="checkbox" class="switch" [ngModel]="form().default" (ngModelChange)="patch({ default: $event })" /> Cocher ce canal par défaut sur les nouvelles alertes</label>
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <div class="sum">
              <span class="sum-icon"><wl-nav-icon [name]="type().icon" [size]="18" /></span>
              <p class="phrase">{{ summary() }}</p>
            </div>
          </div>
          <div class="block">
            <h3>Essai</h3>
            <p class="muted small">Envoie un message de test avec les réglages ci-contre, sans enregistrer.</p>
            <div>
              <button class="btn" (click)="test()" [disabled]="sending() || !form().target.trim()">
                @if (sending()) { <span class="spinner"></span> } @else { <wl-nav-icon name="play" [size]="13" /> }
                {{ sending() ? 'Envoi…' : 'Envoyer un test' }}
              </button>
            </div>
            @if (message(); as m) {
              @if (!sending()) {
                <p class="small result" [class.danger]="m.error" [class.ok]="!m.error" animate.enter="fade-in"><wl-nav-icon [name]="m.error ? 'warning' : 'ok'" [size]="14" />{{ m.text }}</p>
              }
            }
          </div>
          @if (error()) { <div class="block"><span class="danger small err" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy() || !valid()">
              @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="isNew() ? 'plus' : 'check'" [size]="15" /> }
              {{ isNew() ? 'Ajouter le canal' : 'Enregistrer' }}
            </button>
            <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Annuler</a>
            <span class="spacer"></span>
            @if (!isNew()) {
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

    /* Types : carte avec icône qui pivote au survol et se remplit une fois choisie. */
    .choice.kind { grid-template-columns: 34px minmax(0, 1fr); column-gap: 12px; row-gap: 2px; align-items: center; }
    .kind .k-icon { grid-row: span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: var(--accent);
      background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
      transition: transform .4s var(--spring), color .25s, background-color .25s; }
    .kind:hover .k-icon { transform: scale(1.1) rotate(-8deg); }
    .kind.on .k-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 16px -8px var(--accent);
      animation: icon-pop .5s var(--spring); }
    @keyframes icon-pop { 40% { transform: scale(1.18) rotate(-10deg); } }

    /* Destination : icône dans le champ, vérification immédiate de la saisie. */
    .target { position: relative; display: block; }
    .target input { width: 100%; padding-left: 36px; }
    .t-icon { position: absolute; left: 11px; top: 50%; z-index: 1; display: grid; color: var(--text-3); pointer-events: none; transform: translateY(-50%); transition: color .25s; }
    .target:focus-within .t-icon { color: var(--accent); }
    .check-line { display: flex; align-items: center; gap: 6px; margin: -4px 0 0; font-size: 12px; color: var(--ok); }
    .check-line.ko { color: var(--warn); }
    .callout { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 12.5px; line-height: 1.5;
      color: var(--text-1); background: color-mix(in srgb, var(--warn) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); }
    .callout > wl-nav-icon { flex: none; margin-top: 1px; color: var(--warn); }

    .sum { display: flex; align-items: flex-start; gap: 12px; }
    .sum-icon { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 11px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -10px var(--accent); }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    .result, .err { display: flex; align-items: center; gap: 6px; }
    .fade-in { animation: fade-in .35s var(--spring); }
    @keyframes fade-in { from { opacity: 0; transform: translateY(4px) scale(.97); } }
    .check { display: flex; gap: 10px; align-items: center; font-size: 13px; }

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
export class ChannelFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
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
  protected readonly sending = signal(false);
  protected readonly confirmDelete = signal(false);
  protected readonly deleting = signal(false);
  protected readonly smtpMissing = signal(false);

  protected readonly isNew = computed(() => !this.id() || this.id() === 'new');
  protected readonly type = computed(() => CHANNEL_TYPES.find((t) => t.value === this.form().type) ?? CHANNEL_TYPES[0]);
  protected readonly valid = computed(() => !!this.form().target.trim());

  /** Vérification indicative de la destination (n'empêche pas l'enregistrement : le serveur a le dernier mot). */
  protected readonly targetCheck = computed<{ ok: boolean; text: string } | null>(() => {
    const f = this.form();
    const value = f.target.trim();
    if (!value) return null;
    if (f.type === 'email') {
      const list = value.split(',').map((x) => x.trim()).filter(Boolean);
      const bad = list.find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
      if (bad) return { ok: false, text: `« ${bad} » ne ressemble pas à une adresse e-mail.` };
      return { ok: true, text: list.length > 1 ? `${list.length} destinataires.` : '1 destinataire.' };
    }
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, text: 'L’adresse doit commencer par https://' };
      return { ok: true, text: `Envoi vers ${url.host}${url.protocol === 'http:' ? ' (connexion non chiffrée)' : ''}.` };
    } catch {
      return { ok: false, text: 'Adresse incomplète : collez l’URL entière, https:// compris.' };
    }
  });
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
    this.sending.set(true);
    const f = this.form();
    this.api.testChannel({ ...f, name: f.name.trim() || this.defaultName(), target: f.target.trim() }).subscribe({
      next: () => {
        this.sending.set(false);
        this.message.set({ text: 'Message de test envoyé.', error: false });
        this.toasts.ok('Message de test envoyé', channelIcon(f.type));
      },
      error: (e) => {
        this.sending.set(false);
        const text = e?.error?.error ?? 'Échec de l’envoi.';
        this.message.set({ text, error: true });
        this.toasts.error(text);
      },
    });
  }

  protected save() {
    const f = this.form();
    const isNew = this.isNew();
    this.busy.set(true);
    this.error.set('');
    this.api.saveChannel({ ...f, name: f.name.trim() || this.defaultName(), target: f.target.trim() }).subscribe({
      next: () => {
        this.toasts.ok(isNew ? 'Canal ajouté' : 'Canal enregistré', channelIcon(f.type));
        this.router.navigate(['/alerts'], { queryParams: { tab: 'channels' } });
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
    this.api.deleteChannel(this.form().id).subscribe({
      next: () => {
        this.toasts.ok('Canal supprimé', 'trash');
        this.router.navigate(['/alerts'], { queryParams: { tab: 'channels' } });
      },
      error: (e) => {
        this.deleting.set(false);
        this.confirmDelete.set(false);
        this.toasts.error(e?.error?.error ?? 'Suppression impossible.');
      },
    });
  }
}
