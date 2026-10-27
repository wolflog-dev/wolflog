import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EmailProbeSettings, MailSecurity } from '../core/models';
import { NavIcon } from './nav-icon';
import { RichOption } from './rich-option';

/** Fournisseurs courants : serveurs, ports et sécurité remplis en un clic. */
const PROVIDERS: { name: string; smtp: [string, number, MailSecurity]; imap: [string, number, MailSecurity]; hint?: string }[] = [
  { name: 'Microsoft 365', smtp: ['smtp.office365.com', 587, 'starttls'], imap: ['outlook.office365.com', 993, 'ssl'],
    hint: 'L’envoi SMTP authentifié doit être autorisé pour la boîte (centre d’administration Exchange).' },
  { name: 'Gmail', smtp: ['smtp.gmail.com', 465, 'ssl'], imap: ['imap.gmail.com', 993, 'ssl'],
    hint: 'Avec la validation en deux étapes, utilisez un mot de passe d’application.' },
  { name: 'OVHcloud', smtp: ['ssl0.ovh.net', 465, 'ssl'], imap: ['ssl0.ovh.net', 993, 'ssl'] },
  { name: 'Hostinger', smtp: ['smtp.hostinger.com', 465, 'ssl'], imap: ['imap.hostinger.com', 993, 'ssl'] },
  { name: 'Gandi', smtp: ['mail.gandi.net', 465, 'ssl'], imap: ['mail.gandi.net', 993, 'ssl'] },
  { name: 'Infomaniak', smtp: ['mail.infomaniak.com', 465, 'ssl'], imap: ['mail.infomaniak.com', 993, 'ssl'] },
];

const SECURITY: { value: MailSecurity; label: string; desc: string }[] = [
  { value: 'auto', label: 'Automatique', desc: 'TLS sur 465 / 993, sinon STARTTLS s’il est proposé' },
  { value: 'starttls', label: 'STARTTLS', desc: 'Chiffrement exigé après connexion (587, 143)' },
  { value: 'ssl', label: 'SSL / TLS', desc: 'Chiffré dès la connexion (465, 993)' },
  { value: 'none', label: 'Aucune', desc: 'Réseau interne uniquement : mot de passe en clair' },
];

const DELAYS = [
  { value: 60, label: '1 minute' },
  { value: 180, label: '3 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
];

/** Réglages d'une sonde e-mail : envoi SMTP, message de test, réception IMAP facultative. */
@Component({
  selector: 'wl-email-probe-fields',
  imports: [FormsModule, NavIcon, RichOption],
  template: `
    <div class="providers">
      <span class="muted small">Fournisseur</span>
      @for (pv of providers; track pv.name) {
        <button type="button" class="chip" [class.on]="provider() === pv.name" (click)="usePreset(pv)">{{ pv.name }}</button>
      }
      <button type="button" class="chip" [class.on]="!provider()" (click)="provider.set('')">Autre serveur</button>
    </div>
    @if (providerHint(); as hint) { <p class="note"><wl-nav-icon name="info" [size]="14" />{{ hint }}</p> }

    <div class="group">
      <h3 class="g-title"><wl-nav-icon name="arrow-up" [size]="14" />Envoi (SMTP)</h3>
      <div class="options">
        <label class="field wide">Serveur SMTP <input class="mono" [ngModel]="s().smtpHost" (ngModelChange)="set({ smtpHost: $event })" placeholder="smtp.mondomaine.fr" autocomplete="off" /></label>
        <label class="field port">Port <input type="number" class="mono" min="1" max="65535" [ngModel]="s().smtpPort" (ngModelChange)="set({ smtpPort: +$event })" /></label>
        <label class="field">Sécurité
          <select [ngModel]="s().smtpSecurity" (ngModelChange)="set({ smtpSecurity: $event })">
            @for (o of security; track o.value) { <option [value]="o.value" [wlOpt]="o.label" icon="lock" [desc]="o.desc"></option> }
          </select></label>
      </div>
      <div class="options">
        <label class="field">Compte <input [ngModel]="s().smtpUser ?? ''" (ngModelChange)="set({ smtpUser: $event || null })" placeholder="facultatif, ex. alertes@mondomaine.fr" autocomplete="off" /></label>
        @if (s().smtpUser) {
          <label class="field">Mot de passe
            <input type="password" [ngModel]="s().smtpPassword ?? ''" (ngModelChange)="setSmtpPassword($event)" autocomplete="new-password"
                   [placeholder]="s().hasSmtpPassword ? 'enregistré : laisser vide pour le garder' : ''" /></label>
        }
      </div>
    </div>

    <div class="group">
      <h3 class="g-title"><wl-nav-icon name="mail" [size]="14" />Message de test</h3>
      <div class="options">
        <label class="field">Expéditeur <input [ngModel]="s().from" (ngModelChange)="set({ from: $event })" [placeholder]="s().smtpUser || 'alertes@mondomaine.fr'" autocomplete="off" /></label>
        <label class="field">Destinataire <input [ngModel]="s().to" (ngModelChange)="set({ to: $event })" [placeholder]="defaultTo() || 'boîte qui doit le recevoir'" autocomplete="off" /></label>
      </div>
      <p class="note"><wl-nav-icon name="info" [size]="14" />Chaque message porte l'en-tête <code>X-Wolflog-Probe</code> ; il est supprimé dès son arrivée.</p>
    </div>

    <div class="group">
      <label class="check"><input type="checkbox" class="switch" [ngModel]="receiving()" (ngModelChange)="toggleReception($event)" />
        Vérifier que le message arrive dans la boîte (IMAP)</label>
      @if (receiving()) {
        <div class="options">
          <label class="field wide">Serveur IMAP <input class="mono" [ngModel]="s().imapHost ?? ''" (ngModelChange)="set({ imapHost: $event })" placeholder="imap.mondomaine.fr" autocomplete="off" /></label>
          <label class="field port">Port <input type="number" class="mono" min="1" max="65535" [ngModel]="s().imapPort" (ngModelChange)="set({ imapPort: +$event })" /></label>
          <label class="field">Sécurité
            <select [ngModel]="s().imapSecurity" (ngModelChange)="set({ imapSecurity: $event })">
              @for (o of security; track o.value) { <option [value]="o.value" [wlOpt]="o.label" icon="lock" [desc]="o.desc"></option> }
            </select></label>
        </div>
        <label class="check"><input type="checkbox" class="switch" [ngModel]="sameAccount()" (ngModelChange)="useSameAccount($event)" />
          Même compte que pour l'envoi</label>
        @if (!sameAccount()) {
          <div class="options">
            <label class="field">Compte de la boîte <input [ngModel]="s().imapUser ?? ''" (ngModelChange)="set({ imapUser: $event || null })" placeholder="ex. supervision@mondomaine.fr" autocomplete="off" /></label>
            <label class="field">Mot de passe
              <input type="password" [ngModel]="s().imapPassword ?? ''" (ngModelChange)="set({ imapPassword: $event || null })" autocomplete="new-password"
                     [placeholder]="s().hasImapPassword ? 'enregistré : laisser vide pour le garder' : ''" /></label>
          </div>
        }
        <div class="options">
          <label class="field">Dossier <input [ngModel]="s().folder" (ngModelChange)="set({ folder: $event || 'INBOX' })" placeholder="INBOX" /></label>
          <label class="field">Délai d'arrivée maximal
            <select [ngModel]="s().deliveryTimeoutSeconds" (ngModelChange)="set({ deliveryTimeoutSeconds: +$event })">
              @for (d of delays; track d.value) { <option [value]="d.value" [wlOpt]="d.label" icon="timer"></option> }
            </select></label>
        </div>
        <label class="check"><input type="checkbox" class="switch" [ngModel]="s().spamIsFailure" (ngModelChange)="set({ spamIsFailure: $event })" />
          Un message arrivé dans les indésirables est un échec</label>
      }
    </div>
  `,
  styles: `
    :host { display: grid; gap: 16px; }
    .providers { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .chip { height: 28px; padding: 0 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-2);
      font: 500 12.5px var(--sans); cursor: pointer; transition: border-color .2s, color .2s, background-color .2s; }
    .chip:hover { border-color: var(--text-3); color: var(--text-1); }
    .chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    .group { display: grid; gap: 10px; }
    .g-title { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 13px; color: var(--text-1); }
    .g-title wl-nav-icon { color: var(--accent); }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 200px; flex: 1; }
    .options .field.wide { flex: 2; min-width: 240px; }
    .options .field.port { flex: none; min-width: 0; width: 96px; }
    .note { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; color: var(--text-3); }
    .note wl-nav-icon { color: var(--accent); flex: none; }
    label.check { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-1); cursor: pointer; }
  `,
})
export class EmailProbeFields {
  readonly settings = input.required<EmailProbeSettings>();
  readonly changed = output<Partial<EmailProbeSettings>>();

  protected readonly providers = PROVIDERS;
  protected readonly security = SECURITY;
  protected readonly delays = DELAYS;
  protected readonly s = computed(() => this.settings());
  protected readonly provider = signal('');
  /** Destinataire proposé : la boîte vérifiée (compte IMAP), sinon le compte d'envoi. */
  protected readonly defaultTo = computed(() => (this.receiving() ? this.s().imapUser : null) || this.s().smtpUser || '');
  protected readonly providerHint = computed(() => PROVIDERS.find((p) => p.name === this.provider())?.hint ?? '');
  /** Réception vérifiée : serveur IMAP renseigné ou en cours de saisie (chaîne vide) ; null = désactivée. */
  protected readonly receiving = computed(() => this.s().imapHost !== null && this.s().imapHost !== undefined);
  /** Même compte pour la réception (le cas courant) : compte et mot de passe de l'envoi repris. */
  private readonly separateAccount = signal<boolean | null>(null);
  protected readonly sameAccount = computed(() => {
    const explicit = this.separateAccount();
    if (explicit !== null) return !explicit;
    const s = this.s();
    return !s.imapUser || s.imapUser === s.smtpUser;
  });

  protected set(change: Partial<EmailProbeSettings>) {
    const next = { ...this.s(), ...change };
    // Réception avec le même compte : le compte de l'envoi est repris tel quel.
    if (this.receiving() && this.sameAccount() && ('smtpUser' in change)) change = { ...change, imapUser: next.smtpUser };
    this.changed.emit(change);
  }

  protected setSmtpPassword(value: string) {
    this.set(this.sameAccount() ? { smtpPassword: value || null, imapPassword: value || null } : { smtpPassword: value || null });
  }

  protected usePreset(pv: (typeof PROVIDERS)[number]) {
    this.provider.set(pv.name);
    const [smtpHost, smtpPort, smtpSecurity] = pv.smtp;
    const [imapHost, imapPort, imapSecurity] = pv.imap;
    this.set({ smtpHost, smtpPort, smtpSecurity, ...(this.receiving() ? { imapHost, imapPort, imapSecurity } : {}) });
  }

  protected toggleReception(on: boolean) {
    if (!on) {
      this.changed.emit({ imapHost: null });
      return;
    }
    const s = this.s();
    const preset = PROVIDERS.find((p) => p.name === this.provider());
    // Serveur deviné depuis celui de l'envoi : smtp.domaine → imap.domaine.
    const guess = preset?.imap[0] ?? (s.smtpHost.startsWith('smtp.') ? 'imap.' + s.smtpHost.slice(5) : s.smtpHost);
    this.changed.emit({
      imapHost: guess, imapPort: preset?.imap[1] ?? 993, imapSecurity: preset?.imap[2] ?? 'ssl',
      imapUser: this.sameAccount() ? s.smtpUser : s.imapUser, imapPassword: this.sameAccount() ? s.smtpPassword : s.imapPassword,
    });
  }

  protected useSameAccount(same: boolean) {
    this.separateAccount.set(!same);
    const s = this.s();
    this.changed.emit(same ? { imapUser: s.smtpUser, imapPassword: s.smtpPassword ?? null } : { imapUser: null, imapPassword: null });
  }
}
