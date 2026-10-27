import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { DetectedMailSettings, EmailProbeSettings, MailSecurity, MicrosoftMailAuth } from '../core/models';
import { MicrosoftMailAuthFields } from './microsoft-mail-auth';
import { NavIcon } from './nav-icon';
import { RichOption } from './rich-option';

/** Fournisseurs courants : serveurs, ports et sécurité remplis en un clic. */
const PROVIDERS: { name: string; smtp: [string, number, MailSecurity]; imap: [string, number, MailSecurity]; hint?: string; microsoft?: boolean }[] = [
  { name: 'Microsoft 365', smtp: ['smtp.office365.com', 587, 'starttls'], imap: ['outlook.office365.com', 993, 'ssl'], microsoft: true,
    hint: 'Microsoft refuse le mot de passe pour lire la boîte (IMAP) : connexion « Microsoft (OAuth) ».' },
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

/** Hébergeurs dont la connexion se fait en OAuth Microsoft. */
const MICROSOFT_HOSTS = /(^|\.)(office365\.com|outlook\.com)$/i;
/** Point d'entrée MX de Microsoft 365 (Direct Send, connecteur) : port 25, sans authentification. */
const MX_ENDPOINT = /\.mail\.protection\./i;

/**
 * Réglages d'une sonde e-mail : adresse de la boîte (réglages détectés d'après le DNS du domaine), connexion (mot de passe
 * ou compte Microsoft), envoi SMTP, message de test, réception IMAP facultative.
 */
@Component({
  selector: 'wl-email-probe-fields',
  imports: [FormsModule, MicrosoftMailAuthFields, NavIcon, RichOption],
  template: `
    <div class="group">
      <label class="field">Adresse de la boîte à surveiller
        <span class="row">
          <input type="email" [ngModel]="address()" (ngModelChange)="address.set($event)" (keydown.enter)="detect()" (blur)="autoDetect()"
                 placeholder="ex. supervision@mondomaine.fr" autocomplete="off" />
          <button type="button" class="btn" (click)="detect()" [disabled]="detecting() || !validAddress()" title="Trouver les serveurs et le mode de connexion d'après le domaine">
            @if (detecting()) { <span class="spinner"></span> } @else { <wl-nav-icon name="search" [size]="13" /> }
            Détecter les réglages
          </button>
        </span>
        <span class="muted small">Wolflog trouve l'hébergeur (Microsoft 365, Google, OVH…) et ses serveurs d'après le domaine, comme Outlook.</span>
      </label>
      @if (detected(); as d) {
        <div class="found" [class.unknown]="d.provider === 'unknown'" animate.enter="pop-in">
          <wl-nav-icon [name]="d.provider === 'unknown' ? 'warning' : 'ok'" [size]="16" />
          <div>
            <strong>{{ d.provider === 'unknown' ? d.label : (d.provider === 'other' ? 'Serveurs trouvés' : 'Hébergée chez ' + d.label) }}</strong>
            @if (d.evidence) { <span class="muted small mono"> · {{ d.evidence }}</span> }
            @for (n of d.notes; track n) { <p>{{ n }}</p> }
          </div>
        </div>
      }
      <div class="providers">
        <span class="muted small">ou choisissez</span>
        @for (pv of providers; track pv.name) {
          <button type="button" class="chip" [class.on]="provider() === pv.name" (click)="usePreset(pv)">{{ pv.name }}</button>
        }
        <button type="button" class="chip" [class.on]="!provider() && !detected()" (click)="provider.set(''); detected.set(null)">Autre serveur</button>
      </div>
      @if (providerHint(); as hint) { <p class="note"><wl-nav-icon name="info" [size]="14" />{{ hint }}</p> }
    </div>

    <div class="group">
      <h3 class="g-title"><wl-nav-icon name="lock" [size]="14" />Connexion</h3>
      <div class="seg auth" role="radiogroup" aria-label="Connexion">
        <button type="button" role="radio" [class.on]="!microsoft()" [attr.aria-checked]="!microsoft()" (click)="useAuth('password')">Identifiant et mot de passe</button>
        <button type="button" role="radio" [class.on]="microsoft()" [attr.aria-checked]="microsoft()" (click)="useAuth('microsoft')">Microsoft (OAuth)</button>
      </div>
      @if (microsoft()) {
        <wl-microsoft-mail-auth [auth]="msAuth()" [mailbox]="address() || s().smtpUser" (changed)="setMicrosoft($event)" />
      } @else if (microsoftServer()) {
        <p class="note warn"><wl-nav-icon name="warning" [size]="14" />Serveur Microsoft : le mot de passe est refusé pour lire la boîte (IMAP), et souvent pour envoyer. Choisissez « Microsoft (OAuth) ».</p>
      }
    </div>

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
        <label class="field">Compte <input [ngModel]="s().smtpUser ?? ''" (ngModelChange)="set({ smtpUser: $event || null })"
          [placeholder]="smtpViaMicrosoft() ? (msAuth().account || 'compte connecté') : 'facultatif, ex. alertes@mondomaine.fr'" autocomplete="off" /></label>
        @if (s().smtpUser && !smtpViaMicrosoft()) {
          <label class="field">Mot de passe
            <input type="password" [ngModel]="s().smtpPassword ?? ''" (ngModelChange)="setSmtpPassword($event)" autocomplete="new-password"
                   [placeholder]="s().hasSmtpPassword ? 'enregistré : laisser vide pour le garder' : ''" /></label>
        }
      </div>
    </div>

    @if (microsoft() && s().smtpHost.trim() && !smtpViaMicrosoft()) {
      <p class="note"><wl-nav-icon name="info" [size]="14" />Relais de l'entreprise, Direct Send ou connecteur Microsoft 365 : l'envoi se fait sans identifiant (laissez « Compte » vide) ou avec le compte du relais ;
        le compte Microsoft sert seulement à lire la boîte.</p>
    }

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
        @if (microsoft()) {
          <div class="options">
            <label class="field">Boîte à lire <input [ngModel]="s().imapUser ?? ''" (ngModelChange)="set({ imapUser: $event || null })"
              [placeholder]="msAuth().account || 'compte connecté'" autocomplete="off" />
              <span class="muted small">Vide : celle du compte connecté. Une boîte partagée : son adresse.</span></label>
          </div>
        } @else {
          <label class="check"><input type="checkbox" class="switch" [ngModel]="sameAccount()" (ngModelChange)="useSameAccount($event)" />
            Même compte que pour l'envoi</label>
        }
        @if (!sameAccount() && !microsoft()) {
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
    .row { display: flex; gap: 8px; }
    .row input { flex: 1; min-width: 0; }
    .found { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; border-radius: var(--radius-sm); font-size: 12.5px; line-height: 1.5;
      border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 7%, transparent); }
    .found > wl-nav-icon { color: var(--ok); margin-top: 1px; }
    .found.unknown { border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent); }
    .found.unknown > wl-nav-icon { color: var(--warn); }
    .found p { margin: 3px 0 0; color: var(--text-2); }
    .auth { justify-self: start; }
    .note.warn, .note.warn wl-nav-icon { color: var(--warn); }
    .pop-in { animation: pop-in .35s var(--spring); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(4px) scale(.97); } }
    .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(1turn); } }
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
  private readonly api = inject(Api);
  readonly settings = input.required<EmailProbeSettings>();
  readonly changed = output<Partial<EmailProbeSettings>>();

  /** Adresse de la boîte : départ de la détection, reprise comme compte, expéditeur et destinataire. */
  protected readonly address = signal('');
  protected readonly detecting = signal(false);
  protected readonly detected = signal<DetectedMailSettings | null>(null);
  private detectedFor = '';
  protected readonly validAddress = computed(() => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(this.address().trim()));
  protected readonly microsoft = computed(() => this.s().auth === 'microsoft');
  protected readonly msAuth = computed<MicrosoftMailAuth>(() => this.s().microsoft ?? { mode: 'account', tenant: null, clientId: null });
  /** Serveur de Microsoft saisi alors que la connexion est par mot de passe : à signaler. */
  /** Connexion Microsoft et envoi par un serveur de Microsoft : le jeton sert aussi pour l'envoi (sinon : relais). */
  protected readonly smtpViaMicrosoft = computed(() => this.microsoft() && MICROSOFT_HOSTS.test(this.s().smtpHost.trim()) && !MX_ENDPOINT.test(this.s().smtpHost));
  protected readonly microsoftServer = computed(() => (MICROSOFT_HOSTS.test(this.s().smtpHost.trim()) && !MX_ENDPOINT.test(this.s().smtpHost))
    || MICROSOFT_HOSTS.test(this.s().imapHost?.trim() ?? ''));

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

  constructor() {
    queueMicrotask(() => this.address.set(this.s().smtpUser || this.s().from || this.s().imapUser || ''));
  }

  /** Détection à la sortie du champ, si rien n'est encore réglé pour cette adresse. */
  protected autoDetect() {
    if (this.validAddress() && !this.s().smtpHost && this.address().trim() !== this.detectedFor) this.detect();
  }

  protected detect() {
    const address = this.address().trim();
    if (!this.validAddress() || this.detecting()) return;
    this.detecting.set(true);
    this.api.detectMail(address).subscribe({
      next: (d) => {
        this.detecting.set(false);
        this.detectedFor = address;
        this.detected.set(d);
        this.provider.set('');
        this.apply(d, address);
      },
      error: () => this.detecting.set(false),
    });
  }

  /** Réglages détectés : serveurs, compte (l'adresse), expéditeur et destinataire s'ils sont vides, mode de connexion. */
  private apply(d: DetectedMailSettings, address: string) {
    const s = this.s();
    const change: Partial<EmailProbeSettings> = { smtpUser: address, from: s.from || address, to: s.to || address };
    if (d.smtp) Object.assign(change, { smtpHost: d.smtp.host, smtpPort: d.smtp.port, smtpSecurity: d.smtp.security });
    if (d.imap && this.receiving()) Object.assign(change, { imapHost: d.imap.host, imapPort: d.imap.port, imapSecurity: d.imap.security });
    if (this.receiving() && this.sameAccount()) change.imapUser = address;
    if (d.auth === 'microsoft') Object.assign(change, { auth: 'microsoft', microsoft: this.msAuth() });
    else if (d.provider !== 'unknown') change.auth = 'password';
    this.changed.emit(change);
  }

  protected useAuth(auth: 'password' | 'microsoft') {
    this.changed.emit(auth === 'microsoft' ? { auth, microsoft: this.msAuth() } : { auth });
  }

  protected setMicrosoft(change: Partial<MicrosoftMailAuth>) {
    this.changed.emit({ microsoft: { ...this.msAuth(), ...change } });
  }

  protected set(change: Partial<EmailProbeSettings>) {
    const next = { ...this.s(), ...change };
    // Réception avec le même compte : le compte de l'envoi est repris tel quel.
    // Connexion Microsoft : le compte d'envoi peut être celui d'un relais, la boîte lue reste la sienne.
    if (this.receiving() && this.sameAccount() && !this.microsoft() && ('smtpUser' in change)) change = { ...change, imapUser: next.smtpUser };
    this.changed.emit(change);
  }

  protected setSmtpPassword(value: string) {
    this.set(this.sameAccount() && !this.microsoft() ? { smtpPassword: value || null, imapPassword: value || null } : { smtpPassword: value || null });
  }

  protected usePreset(pv: (typeof PROVIDERS)[number]) {
    this.provider.set(pv.name);
    this.detected.set(null);
    const [smtpHost, smtpPort, smtpSecurity] = pv.smtp;
    const [imapHost, imapPort, imapSecurity] = pv.imap;
    this.set({ smtpHost, smtpPort, smtpSecurity, ...(this.receiving() ? { imapHost, imapPort, imapSecurity } : {}),
      ...(pv.microsoft ? { auth: 'microsoft' as const, microsoft: this.msAuth() } : { auth: 'password' as const }) });
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
