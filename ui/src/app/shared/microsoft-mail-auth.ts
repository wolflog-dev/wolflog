import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { DeviceConnection, MicrosoftMailAuth } from '../core/models';
import { Toasts } from '../core/toasts';
import { NavIcon } from './nav-icon';

/**
 * Connexion OAuth à une messagerie Microsoft (Microsoft 365, Outlook.com), Microsoft refusant le mot de passe en IMAP :
 * compte connecté par code (microsoft.com/devicelogin), ou application Entra ID créée par l'administrateur. Les consignes
 * pour l'administrateur sont prêtes à transmettre.
 */
@Component({
  selector: 'wl-microsoft-mail-auth',
  imports: [FormsModule, NavIcon],
  template: `
    <div class="seg modes" role="radiogroup" aria-label="Type de connexion Microsoft">
      <button type="button" role="radio" [class.on]="a().mode === 'account'" [attr.aria-checked]="a().mode === 'account'" (click)="set({ mode: 'account' })">
        <wl-nav-icon name="account" [size]="13" />Compte Microsoft</button>
      <button type="button" role="radio" [class.on]="a().mode === 'app'" [attr.aria-checked]="a().mode === 'app'" (click)="set({ mode: 'app' })">
        <wl-nav-icon name="shield" [size]="13" />Application Entra ID</button>
    </div>

    @if (a().mode === 'account') {
      @if (device(); as d) {
        <div class="device" animate.enter="pop-in">
          <span class="muted small">1. Ouvrez la page de Microsoft, 2. saisissez ce code, 3. connectez-vous avec le compte de la boîte{{ mailbox() ? ' (' + mailbox() + ')' : '' }}.</span>
          <div class="code-row">
            <code class="code">{{ d.userCode }}</code>
            <button type="button" class="btn ghost small-btn" (click)="copy(d.userCode)"><wl-nav-icon name="copy" [size]="13" />Copier</button>
            <a class="btn primary small-btn" [href]="d.verificationUri" target="_blank" rel="noopener"><wl-nav-icon name="external" [size]="13" />Ouvrir {{ host(d.verificationUri) }}</a>
          </div>
          <span class="waiting"><span class="spinner"></span>En attente de la connexion chez Microsoft…</span>
          <button type="button" class="link small" (click)="cancel()">Annuler</button>
        </div>
      } @else if (connectedAs(); as who) {
        <div class="connected" animate.enter="pop-in">
          <span class="c-icon"><wl-nav-icon name="ok" [size]="16" /></span>
          <span><strong>Connecté : {{ who }}</strong><span class="muted small">Wolflog renouvelle l'accès tout seul ; rien n'est demandé à chaque vérification.</span></span>
          <button type="button" class="btn ghost small-btn" (click)="connect()" [disabled]="connecting()"><wl-nav-icon name="refresh" [size]="13" />Reconnecter</button>
        </div>
      } @else {
        <div class="connect-row">
          <button type="button" class="btn primary" (click)="connect()" [disabled]="connecting() || !clientId()">
            @if (connecting()) { <span class="spinner"></span> } @else { <wl-nav-icon name="login" [size]="14" /> }
            Se connecter avec Microsoft
          </button>
          @if (!clientId()) { <span class="muted small">Indiquez d'abord l'ID d'application ci-dessous.</span> }
        </div>
      }
      @if (error()) { <span class="danger small err" animate.enter="pop-in"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span> }
    }

    <div class="options">
      <label class="field">ID d'application (client)
        <input class="mono" [ngModel]="a().clientId ?? ''" (ngModelChange)="set({ clientId: $event.trim() || null })" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off" />
        @if (defaultsSource() === 'sso' && a().clientId === defaults()?.clientId) { <span class="muted small">Celle de la connexion unique de Wolflog.</span> }
      </label>
      <label class="field">Annuaire (locataire)
        <input class="mono" [ngModel]="a().tenant ?? ''" (ngModelChange)="set({ tenant: $event.trim() || null })" [placeholder]="defaultTenant()" autocomplete="off" />
        <span class="muted small">Vide : {{ defaultTenant() }}.</span></label>
      @if (a().mode === 'app') {
        <label class="field">Secret client
          <input type="password" [ngModel]="a().clientSecret ?? ''" (ngModelChange)="set({ clientSecret: $event || null })" autocomplete="new-password"
                 [placeholder]="a().hasClientSecret ? 'enregistré : laisser vide pour le garder' : 'valeur du secret'" /></label>
      }
    </div>

    <details class="guide">
      <summary><wl-nav-icon name="info" [size]="13" />{{ a().mode === 'app' ? 'Ce que l’administrateur Microsoft 365 doit faire' : 'Pas d’ID d’application ? Ce que l’administrateur Microsoft 365 doit faire' }}</summary>
      @if (a().mode === 'account') {
        <ol>
          <li>Entra ID &gt; Inscriptions d'applications &gt; <strong>Nouvelle inscription</strong> (ex. « Wolflog – messagerie »), comptes de cet annuaire.</li>
          <li>Authentification &gt; Paramètres avancés : <strong>Autoriser les flux clients publics</strong> = Oui.</li>
          <li>Autorisations d'API &gt; Microsoft Graph &gt; Autorisations déléguées : <code>SMTP.Send</code>, <code>IMAP.AccessAsUser.All</code>, <code>offline_access</code>, puis <strong>Accorder le consentement</strong>.</li>
          <li>Pour la boîte : « SMTP authentifié » et « IMAP » activés (centre d'administration &gt; Utilisateurs &gt; le compte &gt; Courrier &gt; Gérer les applications de messagerie).</li>
          <li>Transmettre l'<strong>ID d'application (client)</strong> à saisir ici.</li>
        </ol>
      } @else {
        <ol>
          <li>Entra ID &gt; Inscriptions d'applications &gt; <strong>Nouvelle inscription</strong>, puis Certificats et secrets &gt; <strong>Nouveau secret client</strong>.</li>
          <li>Autorisations d'API &gt; API utilisées par mon organisation &gt; <strong>Office 365 Exchange Online</strong> &gt; Autorisations d'application : <code>SMTP.SendAsApp</code>, <code>IMAP.AccessAsApp</code>, puis <strong>Accorder le consentement</strong>.</li>
          <li>Donner à l'application l'accès à la boîte (Exchange Online PowerShell ; l'ID d'objet est celui de l'<em>application d'entreprise</em>) :</li>
        </ol>
        <div class="script">
          <pre class="mono">{{ script() }}</pre>
          <button type="button" class="btn ghost small-btn" (click)="copy(script())"><wl-nav-icon name="copy" [size]="13" />Copier</button>
        </div>
      }
    </details>
  `,
  styles: `
    :host { display: grid; gap: 12px; }
    .modes { justify-self: start; }
    .modes button { display: inline-flex; align-items: center; gap: 6px; }
    .connect-row, .code-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .connected { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); }
    .connected > span:nth-child(2) { display: grid; gap: 2px; flex: 1; min-width: 0; }
    .c-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 50%; color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
    .device { display: grid; gap: 10px; justify-items: start; padding: 12px; border-radius: var(--radius-sm);
      border: 1px dashed color-mix(in srgb, var(--accent) 50%, var(--border)); background: color-mix(in srgb, var(--accent) 5%, transparent); }
    .code { padding: 4px 12px; border-radius: 8px; font: 650 20px/1.4 var(--mono); letter-spacing: .12em; color: var(--text-1); background: var(--surface-2);
      border: 1px solid var(--border); user-select: all; }
    .waiting { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); }
    .small-btn { height: 30px; font-size: 12.5px; }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { display: grid; gap: 4px; align-content: start; min-width: 220px; flex: 1; font-size: 12px; color: var(--text-2); }
    .guide { font-size: 12.5px; color: var(--text-2); }
    .guide summary { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); cursor: pointer; list-style: none; }
    .guide summary::-webkit-details-marker { display: none; }
    .guide ol { display: grid; gap: 4px; margin: 8px 0 0; padding-left: 20px; line-height: 1.5; }
    .guide code { font: 12px var(--mono); color: var(--text-1); }
    .script { display: flex; align-items: flex-start; gap: 8px; margin-top: 6px; }
    .script pre { flex: 1; min-width: 0; margin: 0; padding: 8px 10px; overflow-x: auto; border-radius: var(--radius-sm); font-size: 11.5px; line-height: 1.5;
      background: var(--surface-2); border: 1px solid var(--border-soft); color: var(--text-1); }
    .link { border: 0; padding: 0; background: none; color: var(--text-3); cursor: pointer; font-family: inherit; }
    .link:hover { color: var(--accent); }
    .err { display: inline-flex; align-items: center; gap: 6px; }
    .pop-in { animation: pop-in .35s var(--spring); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(4px) scale(.97); } }
    .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(1turn); } }
  `,
})
export class MicrosoftMailAuthFields {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);

  readonly auth = input.required<MicrosoftMailAuth>();
  /** Adresse de la boîte : annuaire par défaut (domaine) et rappel du compte à connecter. */
  readonly mailbox = input<string | null>(null);
  readonly changed = output<Partial<MicrosoftMailAuth>>();

  protected readonly a = computed(() => this.auth());
  protected readonly device = signal<DeviceConnection | null>(null);
  protected readonly connecting = signal(false);
  protected readonly error = signal('');
  protected readonly defaults = signal<{ clientId: string | null; tenant: string | null; source: 'config' | 'sso' | null } | null>(null);
  protected readonly defaultsSource = computed(() => this.defaults()?.source ?? null);
  protected readonly clientId = computed(() => this.a().clientId?.trim() || '');
  protected readonly connectedAs = computed(() => (this.a().connected || this.a().connectionId) ? (this.a().account || 'compte Microsoft') : null);
  /** Annuaire proposé : celui du domaine de la boîte (Outlook.com : comptes personnels). */
  protected readonly defaultTenant = computed(() => {
    const domain = (this.mailbox() ?? '').split('@').pop()?.replace(/>$/, '').trim().toLowerCase() ?? '';
    if (!domain.includes('.')) return 'organizations';
    return /^(outlook|hotmail|live)\.(com|fr)$|^msn\.com$/.test(domain) ? 'consumers' : domain;
  });
  protected readonly script = computed(() => {
    const app = this.clientId() || '<ID d’application>';
    const box = this.mailbox() || '<adresse de la boîte>';
    return `Connect-ExchangeOnline\nNew-ServicePrincipal -AppId ${app} -ObjectId <ID d’objet de l’application d’entreprise>\n`
      + `Add-MailboxPermission -Identity ${box} -User <ID d’objet de l’application d’entreprise> -AccessRights FullAccess`;
  });

  private poll: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.api.microsoftMailDefaults().subscribe({
      next: (d) => {
        this.defaults.set(d);
        // Application déjà connue de Wolflog : proposée d'office.
        if (d.clientId && !this.a().clientId) this.set({ clientId: d.clientId, ...(d.tenant && !this.a().tenant ? { tenant: d.tenant } : {}) });
      },
      error: () => {},
    });
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  /** Autre application ou autre annuaire : la connexion du compte ne vaut plus, il faut le reconnecter. */
  protected set(change: Partial<MicrosoftMailAuth>) {
    const a = this.a();
    const otherApp = ('clientId' in change && (change.clientId ?? null) !== (a.clientId ?? null))
      || ('tenant' in change && (change.tenant ?? null) !== (a.tenant ?? null) && !('connectionId' in change));
    this.changed.emit(otherApp && (a.connected || a.connectionId) ? { ...change, connectionId: null, connected: false, account: null } : change);
  }

  protected host(url: string) {
    try { return new URL(url).host; } catch { return url; }
  }

  protected copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => this.toasts.ok('Copié', 'copy'), () => {});
  }

  /** Connexion par code : Microsoft affiche une page où saisir le code ; Wolflog attend qu'elle aboutisse. */
  protected connect() {
    this.error.set('');
    this.connecting.set(true);
    this.api.connectMicrosoftMail(this.a().tenant || this.defaultTenant(), this.clientId()).subscribe({
      next: (d) => {
        this.connecting.set(false);
        this.device.set(d);
        this.schedule(d.id, Math.max(2, d.interval));
      },
      error: (e) => {
        this.connecting.set(false);
        this.error.set(e?.error?.error ?? 'Connexion à Microsoft impossible.');
      },
    });
  }

  private schedule(id: string, seconds: number) {
    this.stopPolling();
    this.poll = setTimeout(() => this.api.microsoftMailConnection(id).subscribe({
      next: (s) => {
        if (s.status === 'pending') return this.schedule(id, seconds);
        this.device.set(null);
        if (s.status === 'ok') {
          this.set({ connectionId: id, account: s.account, tenant: this.a().tenant || this.defaultTenant() });
          this.toasts.ok(`Compte ${s.account ?? 'Microsoft'} connecté`, 'ok');
        } else this.error.set(s.error ?? 'Connexion refusée.');
      },
      error: () => this.schedule(id, seconds),
    }), seconds * 1000);
  }

  protected cancel() {
    this.stopPolling();
    this.device.set(null);
  }

  private stopPolling() {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
  }
}
