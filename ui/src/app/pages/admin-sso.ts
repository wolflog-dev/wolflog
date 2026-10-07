import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import {
  AccessProfile, LdapAccountReport, LdapInput, LdapKind, LdapProbeReport, LdapSecurity, LdapSettings, Role, SsoAdmin, SsoAutoSignIn, SsoGroupMapping,
  SsoSettings, SsoSettingsInput, SsoTestReport,
} from '../core/models';
import { EVERYTHING } from '../core/access';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { CodeBlock } from '../shared/code-block';
import { CopyText } from '../shared/copy-text';
import { MicrosoftLogo } from '../shared/microsoft-logo';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { Skeleton } from '../shared/skeleton';

/** Rôles proposés (mêmes libellés que la gestion des utilisateurs). */
const ROLES: { value: Role; label: string; hint: string; icon: string; tone: string }[] = [
  { value: 'viewer', label: 'Lecteur', hint: 'Consulte, ne modifie rien', icon: 'eye', tone: 'var(--accent-3)' },
  { value: 'editor', label: 'Éditeur', hint: 'Tableaux de bord, statut des erreurs, alertes, recherches partagées', icon: 'pencil', tone: 'var(--accent)' },
  { value: 'admin', label: 'Administrateur', hint: 'Tout, plus les utilisateurs, clés API, sources et sauvegardes', icon: 'crown', tone: 'var(--warn)' },
];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Filtre et attributs proposés par type d'annuaire (remplis au changement de type). */
const LDAP_PRESETS: Record<LdapKind, Pick<LdapInput, 'userFilter' | 'usernameAttribute' | 'displayNameAttribute' | 'mailAttribute' | 'groupAttribute' | 'nestedGroups'>> = {
  ad: {
    userFilter: '(&(objectCategory=person)(objectClass=user)(|(sAMAccountName={0})(userPrincipalName={0})))',
    usernameAttribute: 'userPrincipalName', displayNameAttribute: 'displayName', mailAttribute: 'mail', groupAttribute: 'memberOf', nestedGroups: true,
  },
  ldap: { userFilter: '(uid={0})', usernameAttribute: 'uid', displayNameAttribute: 'cn', mailAttribute: 'mail', groupAttribute: 'memberOf', nestedGroups: false },
};

/** Chiffrement : port par défaut et libellé. */
const LDAP_SECURITY: { value: LdapSecurity; label: string; port: number }[] = [
  { value: 'ldaps', label: 'LDAPS (636)', port: 636 },
  { value: 'starttls', label: 'StartTLS (389)', port: 389 },
  { value: 'none', label: 'Aucun', port: 389 },
];

/** Annuaire enregistré → formulaire (mot de passe du compte de service toujours vide : il n'est jamais renvoyé). */
function toLdapInput(l: LdapSettings | undefined): LdapInput {
  return {
    enabled: l?.enabled ?? false,
    kind: l?.kind ?? 'ad',
    label: l?.label ?? '',
    hosts: l?.hosts ?? '',
    port: l?.port ?? 636,
    security: l?.security ?? 'ldaps',
    ignoreCertificateErrors: l?.ignoreCertificateErrors ?? false,
    caCertificate: l?.caCertificate ?? '',
    baseDn: l?.baseDn ?? '',
    bindDn: l?.bindDn ?? '',
    bindPassword: '',
    upnSuffix: l?.upnSuffix ?? '',
    ...LDAP_PRESETS[l?.kind ?? 'ad'],
    ...(l ? { userFilter: l.userFilter, usernameAttribute: l.usernameAttribute, displayNameAttribute: l.displayNameAttribute,
      mailAttribute: l.mailAttribute, groupAttribute: l.groupAttribute, nestedGroups: l.nestedGroups } : {}),
  };
}

/** Locataire saisi, comme le serveur le comprend : une adresse collée (https://login.microsoftonline.com/…/v2.0) est réduite au locataire. */
function tenantOf(value: string): string {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) {
    try { return new URL(v).pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? ''; } catch { return v.toLowerCase(); }
  }
  return v.toLowerCase();
}

/**
 * Mot de passe enregistré du compte de service réutilisable (même règle que le serveur) : même compte, mêmes serveurs et
 * ports, chiffrement pas affaibli, pas de nouvelle autorité de certification approuvée. Sinon il faut le saisir de nouveau.
 */
function keepsBindPassword(saved: LdapSettings, next: LdapInput): boolean {
  const servers = (hosts: string | null, port: number) => (hosts ?? '').toLowerCase().split(/[\s,;]+/).filter(Boolean)
    .map((h) => (/:\d+$/.test(h) ? h : `${h}:${port}`)).join(',');
  const encrypted = (l: LdapSettings | LdapInput) => l.security !== 'none';
  const verified = (l: LdapSettings | LdapInput) => encrypted(l) && !l.ignoreCertificateErrors;
  return saved.hasBindPassword && !saved.bindPasswordUnreadable
    && (saved.bindDn ?? '').trim().toLowerCase() === next.bindDn.trim().toLowerCase()
    && !(encrypted(saved) && !encrypted(next)) && !(verified(saved) && !verified(next))
    && (!next.caCertificate.trim() || next.caCertificate.trim() === (saved.caCertificate ?? '').trim())
    && servers(saved.hosts, saved.port) === servers(next.hosts, next.port);
}

/** Réglages enregistrés → formulaire (secrets toujours vides : ils ne sont jamais renvoyés). */
function toInput(s: Omit<SsoSettings, 'ldap'> & { ldap?: LdapSettings }): SsoSettingsInput {
  return {
    microsoftEnabled: s.microsoftEnabled,
    tenant: s.tenant ?? '',
    clientId: s.clientId ?? '',
    clientSecret: '',
    buttonLabel: s.buttonLabel || 'Microsoft',
    windowsEnabled: s.windowsEnabled,
    ldap: toLdapInput(s.ldap),
    autoSignIn: s.autoSignIn ?? '',
    allowedDomains: [...s.allowedDomains],
    defaultRole: s.defaultRole,
    defaultProfileId: s.defaultProfileId,
    groupMappings: s.groupMappings.map((m) => ({ group: m.group, name: m.name ?? '', role: m.role, profileId: m.profileId })),
  };
}

/** État d'une méthode dans le résumé : icône et texte coloré. */
interface MethodState { icon: string; tone: 'ok' | 'warn' | 'off'; text: string }

/**
 * Connexion SSO : Microsoft Entra ID (Microsoft 365) réglé ici, avec test de l'inscription et guide du portail Azure ;
 * authentification Windows intégrée ; annuaire LDAP / Active Directory (identifiant et mot de passe de l'entreprise dans
 * le formulaire), avec test de la connexion et d'un compte ; règles des comptes créés à la connexion (domaines, rôle et
 * profil par défaut, groupes de l'annuaire) ; connexion automatique. Aperçu de la page de connexion dans le résumé.
 */
@Component({
  selector: 'wl-admin-sso',
  imports: [FormsModule, RouterLink, AgoPipe, CodeBlock, CopyText, MicrosoftLogo, NavIcon, RichOption, Skeleton],
  template: `
    <div class="page form-page sso">
      <div class="page-head">
        <h1>Connexion SSO</h1>
        <span class="muted small">comptes Microsoft 365, Windows et annuaire de l'entreprise, sans mot de passe Wolflog</span>
        <span class="spacer"></span>
        @if (view()) {
          @if (dirty()) { <button class="btn ghost" (click)="reset()"><wl-nav-icon name="refresh" [size]="14" />Annuler les modifications</button> }
          <button class="btn primary" (click)="save()" [disabled]="busy() || !dirty()">
            @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon name="check" [size]="15" /> }
            Enregistrer
          </button>
        }
      </div>

      @if (view(); as v) {
        <div class="form-grid">
          <div class="steps">
            <!-- 1. Microsoft Entra ID -->
            <section class="panel step" [class.done]="v.active.microsoft || !!v.file">
              <div class="step-head">
                <span class="num">1</span>
                <h2 class="title"><wl-microsoft-logo [size]="15" />Microsoft Entra ID</h2>
                <span class="hint">Microsoft 365, Azure AD</span>
                <span class="spacer"></span>
                @if (!v.file) {
                  <label class="check"><input type="checkbox" class="switch" [ngModel]="form().microsoftEnabled" (ngModelChange)="patch({ microsoftEnabled: $event })" /> Activer</label>
                }
              </div>
              <div class="step-body">
                @if (v.file; as file) {
                  <p class="callout"><wl-nav-icon name="file" [size]="16" />
                    <span>Configurée dans <code>wolflog.json</code> (section <code>Wolflog:Auth:Oidc</code>), qui reste prioritaire : modifiez le fichier
                      puis redémarrez Wolflog, ou retirez la section pour régler la connexion ici.</span></p>
                  <dl class="facts">
                    <div><dt>Autorité</dt><dd class="mono">{{ file.authority }}</dd></div>
                    <div><dt>ID d'application</dt><dd class="mono">{{ file.clientId || '' }}</dd></div>
                    <div><dt>Bouton</dt><dd>Se connecter avec {{ file.displayName }}</dd></div>
                    <div><dt>Rôle par défaut</dt><dd>{{ roleLabel(file.defaultRole) }}</dd></div>
                    <div><dt>Groupes administrateurs</dt><dd class="mono">{{ file.adminGroups.join(', ') || '' }}</dd></div>
                    <div><dt>Groupes éditeurs</dt><dd class="mono">{{ file.editorGroups.join(', ') || '' }}</dd></div>
                  </dl>
                  <div class="uri"><span class="uri-label">URI de redirection</span><code>{{ v.redirectUri }}</code><wl-copy [text]="v.redirectUri" /></div>
                } @else {
                  <div class="fields">
                    <label class="field">Locataire
                      <span class="control"><wl-nav-icon name="building" [size]="14" />
                        <input [ngModel]="form().tenant" (ngModelChange)="patch({ tenant: $event })" placeholder="contoso.onmicrosoft.com" spellcheck="false" autocomplete="off" /></span>
                      <span class="muted small">ID de l'annuaire (locataire) ou domaine vérifié</span>
                    </label>
                    <label class="field">ID d'application (client)
                      <span class="control"><wl-nav-icon name="hash" [size]="14" />
                        <input class="mono" [ngModel]="form().clientId" (ngModelChange)="patch({ clientId: $event })" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" autocomplete="off" /></span>
                      <span class="muted small">Page « Vue d'ensemble » de l'inscription</span>
                    </label>
                    <label class="field">Secret client
                      <span class="control"><wl-nav-icon name="lock" [size]="14" />
                        <input type="password" [ngModel]="form().clientSecret" (ngModelChange)="patch({ clientSecret: $event })" [placeholder]="secretPlaceholder()" autocomplete="new-password" /></span>
                      @if (v.settings.secretUnreadable) {
                        <span class="warn-text small"><wl-nav-icon name="warning" [size]="13" />Secret enregistré illisible (clés de chiffrement changées) : saisissez-le de nouveau.</span>
                      } @else {
                        <span class="muted small">Sa « Valeur », pas son ID. Chiffré sur le serveur, jamais réaffiché.</span>
                      }
                    </label>
                    <label class="field">Texte du bouton
                      <span class="control"><wl-nav-icon name="text" [size]="14" />
                        <input [ngModel]="form().buttonLabel" (ngModelChange)="patch({ buttonLabel: $event })" maxlength="40" placeholder="Microsoft" /></span>
                      <span class="muted small">« Se connecter avec {{ buttonLabel() }} »</span>
                    </label>
                  </div>
                  @if (fieldWarning(); as warning) {
                    <p class="check-line" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="14" />{{ warning }}</p>
                  }
                  <div class="test-row">
                    <button class="btn" (click)="test()" [disabled]="testing() || !form().tenant.trim()">
                      @if (testing()) { <span class="spinner"></span> } @else { <wl-nav-icon name="play" [size]="13" /> }
                      {{ testing() ? 'Vérification…' : 'Tester' }}
                    </button>
                    <span class="muted small">Le serveur interroge Microsoft : locataire, application et secret, sans rien enregistrer.</span>
                  </div>
                  @if (report(); as r) {
                    <ul class="report" animate.enter="fade-in" aria-live="polite">
                      @for (step of r.steps; track step.title) {
                        <li [class]="step.ok === true ? 'ok' : step.ok === false ? 'ko' : 'skip'">
                          <wl-nav-icon [name]="step.ok === true ? 'ok' : step.ok === false ? 'warning' : 'info'" [size]="15" />
                          <span><strong>{{ step.title }}</strong>{{ step.message }}</span>
                        </li>
                      }
                    </ul>
                  }

                  <div class="guide">
                    <button type="button" class="guide-toggle" [class.open]="guideOpen()" (click)="guideOpen.set(!guideOpen())" [attr.aria-expanded]="guideOpen()">
                      <span class="guide-icon"><wl-nav-icon name="page" [size]="15" /></span>
                      <span class="guide-title">Inscrire Wolflog dans Microsoft Entra ID<span class="muted small">6 étapes dans le portail Azure</span></span>
                      <wl-nav-icon class="chev" name="chevron" [size]="15" />
                    </button>
                    @if (guideOpen()) {
                      <ol class="guide-steps" animate.enter="fade-in">
                        <li><span class="n">1</span><div>
                          <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Portail Azure
                            <wl-nav-icon name="external" [size]="12" /></a> › <b>Microsoft Entra ID</b> › <b>Inscriptions d'applications</b> <i>App registrations</i>
                          › <b>Nouvelle inscription</b> <i>New registration</i>. Nom : « Wolflog » ; types de comptes : <b>cet annuaire d'organisation uniquement</b>.
                        </div></li>
                        <li><span class="n">2</span><div>
                          <b>URI de redirection</b> <i>Redirect URI</i> : plateforme <b>Web</b>, avec cette adresse :
                          <div class="uri"><code>{{ v.redirectUri }}</code><wl-copy [text]="v.redirectUri" /></div>
                          @if (httpWarning()) {
                            <p class="warn-text small"><wl-nav-icon name="warning" [size]="13" /><span>Microsoft refuse les adresses en http, sauf localhost : servez Wolflog
                              en HTTPS (IIS, reverse proxy ou certificat Kestrel), puis renseignez son adresse publique dans
                              <a routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Alertes › Canaux</a>.</span></p>
                          }
                          @if (proxyWarning(); as seen) {
                            <p class="warn-text small"><wl-nav-icon name="warning" [size]="13" /><span>Wolflog reçoit les requêtes sous {{ seen }}, alors que vous utilisez
                              {{ origin }} : derrière un reverse proxy, renseignez l'adresse publique de Wolflog dans
                              <a routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Alertes › Canaux</a>, elle devient l'adresse de retour.</span></p>
                          } @else if (v.publicUrl) {
                            <p class="muted small">Déduite de l'adresse publique de Wolflog ({{ v.publicUrl }}, Alertes › Canaux).</p>
                          }
                        </div></li>
                        <li><span class="n">3</span><div>
                          Page <b>Vue d'ensemble</b> <i>Overview</i> : copiez l'<b>ID d'application (client)</b> et l'<b>ID de l'annuaire (locataire)</b> dans les champs ci-dessus.
                        </div></li>
                        <li><span class="n">4</span><div>
                          <b>Certificats et secrets</b> <i>Certificates &amp; secrets</i> › <b>Nouveau secret client</b> : copiez sa <b>Valeur</b> (pas l'ID du secret)
                          dans « Secret client ». Notez son expiration : un secret expiré bloque les connexions.
                        </div></li>
                        <li><span class="n">5</span><div>
                          <b>Configuration des jetons</b> <i>Token configuration</i> › <b>Ajouter une revendication de groupe</b> <i>Add groups claim</i> ›
                          <b>Groupes de sécurité</b> (ou <b>Groupes attribués à l'application</b> au-delà de 200 groupes) › <b>ID de groupe</b>.
                          Indispensable aux correspondances de groupes (étape 5 ci-dessous).
                        </div></li>
                        <li><span class="n">6</span><div>
                          <b>Autorisations d'API</b> <i>API permissions</i> : Microsoft Graph, délégué, <code>openid</code>, <code>profile</code> et <code>email</code>
                          (<code>User.Read</code> est déjà là). <b>Accorder le consentement</b> évite la question aux utilisateurs.
                        </div></li>
                      </ol>
                      <p class="muted small guide-end">Ensuite : « Tester », « Enregistrer », puis « Se connecter avec Microsoft » dans une fenêtre de navigation privée.</p>
                    }
                  </div>
                }
              </div>
            </section>

            <!-- 2. Windows -->
            <section class="panel step" [class.done]="v.active.windows">
              <div class="step-head">
                <span class="num">2</span>
                <h2 class="title"><wl-nav-icon name="desktop" [size]="15" />Windows</h2>
                <span class="hint">Active Directory : Kerberos ou NTLM</span>
                <span class="spacer"></span>
                <label class="check" [title]="v.windowsHost.supported ? '' : v.windowsHost.message">
                  <input type="checkbox" class="switch" [ngModel]="form().windowsEnabled" (ngModelChange)="patch({ windowsEnabled: $event })"
                         [disabled]="!v.windowsHost.supported && !form().windowsEnabled" /> Activer</label>
              </div>
              <div class="step-body">
                <p class="host" [class.ko]="!v.windowsHost.supported"><wl-nav-icon [name]="v.windowsHost.supported ? 'ok' : 'warning'" [size]="15" /><span>{{ v.windowsHost.message }}</span></p>
                <p class="muted small">Sur un PC du domaine, le navigateur transmet la session Windows : la personne entre sans rien saisir. Ses groupes (DOMAINE\\groupe)
                  servent aux correspondances de l’étape 5.</p>
                @if (form().windowsEnabled && form().ldap.enabled) {
                  @if (form().ldap.bindDn.trim()) {
                    <p class="host" animate.enter="fade-in"><wl-nav-icon name="ok" [size]="15" /><span>Annuaire LDAP avec compte de service : la personne connectée par Windows
                      y est retrouvée. Elle garde un seul compte, celui de l'annuaire, avec ses groupes, même sous Linux.</span></p>
                  } @else {
                    <p class="warn-text small" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" /><span>Sans compte de service pour l'annuaire LDAP (étape 3),
                      une même personne aura deux comptes : CONTOSO\\jdupont par Windows, jdupont&#64;contoso.local par l'annuaire. Et sous Linux, la connexion Windows ne
                      reçoit pas ses groupes. Renseignez un compte de service pour les réunir.</span></p>
                  }
                }
                <div class="guide">
                  <button type="button" class="guide-toggle" [class.open]="windowsGuideOpen()" (click)="windowsGuideOpen.set(!windowsGuideOpen())" [attr.aria-expanded]="windowsGuideOpen()">
                    <span class="guide-icon"><wl-nav-icon name="server" [size]="15" /></span>
                    <span class="guide-title">Prérequis du serveur et des navigateurs<span class="muted small">service Windows, IIS ou Linux</span></span>
                    <wl-nav-icon class="chev" name="chevron" [size]="15" />
                  </button>
                  @if (windowsGuideOpen()) {
                    <div class="reqs" animate.enter="fade-in">
                      <div class="req">
                        <h3><wl-nav-icon name="server" [size]="14" />Service Windows</h3>
                        <p>Serveur joint au domaine : Kerberos passe par le compte de l'ordinateur. Pour une adresse DNS dédiée, déclarez son nom de principal de service :</p>
                        <wl-code [code]="spnCommand" lang="PowerShell" />
                      </div>
                      <div class="req">
                        <h3><wl-nav-icon name="globe" [size]="14" />IIS</h3>
                        <p>Activez l'<b>authentification Windows</b> du site en laissant l'<b>authentification anonyme</b> activée (Wolflog garde sa propre session) :</p>
                        <wl-code [code]="iisCommand" lang="PowerShell" />
                      </div>
                      <div class="req">
                        <h3><wl-nav-icon name="terminal" [size]="14" />Linux</h3>
                        <p>Kerberos : keytab du compte de service, dont le SPN est <code>HTTP/wolflog.contoso.local</code> (variable <code>KRB5_KTNAME</code>),
                          et bibliothèque GSSAPI (paquet <code>libgssapi-krb5-2</code>, déjà dans l'image Docker). Ouvrez Wolflog par ce nom, jamais par son adresse IP.
                          Groupes : par l'annuaire LDAP avec un compte de service, sinon le rôle et le profil par défaut s'appliquent.</p>
                      </div>
                      <div class="req">
                        <h3><wl-nav-icon name="cursor" [size]="14" />Navigateurs</h3>
                        <p>Connexion silencieuse : l'adresse de Wolflog dans la zone <b>Intranet local</b> (stratégie de groupe « Liste des attributions de sites
                          aux zones », valeur 1). Chrome et Edge : stratégie <code>AuthServerAllowlist</code> ; Firefox : <code>network.negotiate-auth.trusted-uris</code>.
                          Sinon, le navigateur demande l'identifiant Windows.</p>
                      </div>
                    </div>
                    <p class="muted small">HTTP/1.1, sans reverse proxy entre le navigateur et Wolflog : NTLM et Kerberos sont liés à la connexion.</p>
                  }
                </div>
              </div>
            </section>

            <!-- 3. Annuaire LDAP / Active Directory -->
            <section class="panel step" [class.done]="v.active.ldap">
              <div class="step-head">
                <span class="num">3</span>
                <h2 class="title"><wl-nav-icon name="building" [size]="15" />Annuaire LDAP / Active Directory</h2>
                <span class="hint">identifiant et mot de passe de l'entreprise, dans le formulaire de Wolflog</span>
                <span class="spacer"></span>
                <label class="check"><input type="checkbox" class="switch" [ngModel]="form().ldap.enabled" (ngModelChange)="patchLdap({ enabled: $event })" /> Activer</label>
              </div>
              <div class="step-body">
                <div class="seg ldap-seg" role="group" aria-label="Type d'annuaire">
                  <button type="button" [class.on]="form().ldap.kind === 'ad'" (click)="setLdapKind('ad')">Active Directory</button>
                  <button type="button" [class.on]="form().ldap.kind === 'ldap'" (click)="setLdapKind('ldap')">LDAP (OpenLDAP…)</button>
                </div>
                <div class="fields">
                  <label class="field">Serveurs
                    <span class="control"><wl-nav-icon name="server" [size]="14" />
                      <input [ngModel]="form().ldap.hosts" (ngModelChange)="patchLdap({ hosts: $event })" placeholder="dc1.contoso.local, dc2.contoso.local" spellcheck="false" autocomplete="off" /></span>
                    <span class="muted small">Essayés dans l'ordre ; « hôte:port » pour un autre port</span>
                  </label>
                  <label class="field">Port
                    <span class="control"><wl-nav-icon name="hash" [size]="14" />
                      <input type="number" min="1" max="65535" [ngModel]="form().ldap.port" (ngModelChange)="patchLdap({ port: +$event || 0 })" /></span>
                  </label>
                  <label class="field">Nom de l'annuaire
                    <span class="control"><wl-nav-icon name="text" [size]="14" />
                      <input [ngModel]="form().ldap.label" (ngModelChange)="patchLdap({ label: $event })" placeholder="Contoso" maxlength="40" autocomplete="off" /></span>
                    <span class="muted small">Montré dans Wolflog : « l'annuaire Contoso »</span>
                  </label>
                </div>
                <div class="ldap-security">
                  <span class="field-label">Chiffrement</span>
                  <div class="seg ldap-seg" role="group" aria-label="Chiffrement">
                    @for (s of ldapSecurity; track s.value) {
                      <button type="button" [class.on]="form().ldap.security === s.value" (click)="setLdapSecurity(s.value)">{{ s.label }}</button>
                    }
                  </div>
                  @if (form().ldap.security === 'none') {
                    <p class="warn-text small" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" /><span>Sans chiffrement, les mots de passe circulent en
                      clair sur le réseau : à réserver aux essais (annuaire de démonstration, réseau isolé).</span></p>
                  } @else {
                    <label class="check"><input type="checkbox" class="switch" [ngModel]="form().ldap.ignoreCertificateErrors"
                                                (ngModelChange)="patchLdap({ ignoreCertificateErrors: $event })" /> Ignorer les erreurs de certificat</label>
                    @if (form().ldap.ignoreCertificateErrors) {
                      <p class="warn-text small" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" /><span>Réservé aux essais : n'importe quel serveur
                        pourrait se faire passer pour l'annuaire et recevoir les mots de passe. Collez plutôt l'autorité de certification de l'entreprise
                        ci-dessous, puis décochez cette case.</span></p>
                    }
                    <label class="field ca-field">Autorité de certification <span class="muted">(facultatif)</span>
                      <textarea class="mono" rows="3" [ngModel]="form().ldap.caCertificate" (ngModelChange)="patchLdap({ caCertificate: $event })"
                                placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false" autocomplete="off"></textarea>
                      @if (savedCa(); as ca) {
                        <span class="muted small"><wl-nav-icon name="ok" [size]="12" /> Approuvée pour cet annuaire : {{ ca }}</span>
                      } @else {
                        <span class="muted small">Autorité interne de l'entreprise (AD CS) au format PEM : la racine, et les intermédiaires si l'annuaire ne les
                          envoie pas. Approuvée pour cet annuaire seulement, sans rien installer sur le serveur ni dans l'image Docker ; le nom du serveur reste vérifié.</span>
                      }
                    </label>
                  }
                </div>
                <!-- Libellé séparé : le bouton ne fait pas partie du nom du champ. -->
                <div class="base-dn">
                  <label for="ldap-base-dn">DN de base</label>
                  <div class="with-action">
                    <span class="control"><wl-nav-icon name="sources" [size]="14" />
                      <input id="ldap-base-dn" class="mono" [ngModel]="form().ldap.baseDn" (ngModelChange)="patchLdap({ baseDn: $event })" placeholder="DC=contoso,DC=local"
                             spellcheck="false" autocomplete="off" /></span>
                    <button type="button" class="btn" (click)="readBaseDn()" [disabled]="ldapTesting() || !form().ldap.hosts.trim()">
                      @if (readingBaseDn()) { <span class="spinner"></span> } @else { <wl-nav-icon name="download" [size]="13" /> }
                      Lire depuis l'annuaire
                    </button>
                  </div>
                  <span class="muted small">Point de départ des recherches : les comptes hors de cette branche ne peuvent pas se connecter.</span>
                </div>
                <div class="fields">
                  <label class="field">Compte de service <span class="muted">(facultatif)</span>
                    <span class="control"><wl-nav-icon name="account" [size]="14" />
                      <input [ngModel]="form().ldap.bindDn" (ngModelChange)="patchLdap({ bindDn: $event })" spellcheck="false" autocomplete="off"
                             [placeholder]="form().ldap.kind === 'ad' ? 'svc-wolflog@contoso.local, ou son DN' : 'cn=wolflog,ou=services,dc=contoso,dc=local'" /></span>
                    <span class="muted small">{{ form().ldap.kind === 'ad'
                      ? 'Sans lui, chaque personne cherche son propre compte, après une liaison par UPN.'
                      : 'Sans lui, les comptes sont cherchés en anonyme.' }}</span>
                  </label>
                  <label class="field">Mot de passe du compte de service
                    <span class="control"><wl-nav-icon name="lock" [size]="14" />
                      <input type="password" [ngModel]="form().ldap.bindPassword" (ngModelChange)="patchLdap({ bindPassword: $event })"
                             [placeholder]="bindPasswordPlaceholder()" autocomplete="new-password" [disabled]="!form().ldap.bindDn.trim()" /></span>
                    @if (v.settings.ldap.bindPasswordUnreadable) {
                      <span class="warn-text small"><wl-nav-icon name="warning" [size]="13" />Mot de passe enregistré illisible (clés de chiffrement changées) : saisissez-le de nouveau.</span>
                    } @else if (bindPasswordDropped()) {
                      <span class="warn-text small"><wl-nav-icon name="warning" [size]="13" /><span>Compte, serveurs ou chiffrement modifiés : saisissez de nouveau le mot de
                        passe, l'enregistré ne part jamais vers une autre cible.</span></span>
                    } @else {
                      <span class="muted small">Chiffré sur le serveur, jamais réaffiché.</span>
                    }
                  </label>
                  @if (form().ldap.kind === 'ad') {
                    <label class="field">Suffixe UPN
                      <span class="control"><wl-nav-icon name="globe" [size]="14" />
                        <input [ngModel]="form().ldap.upnSuffix" (ngModelChange)="patchLdap({ upnSuffix: $event })" placeholder="contoso.local" spellcheck="false" autocomplete="off" /></span>
                      <span class="muted small">jdupont → jdupont&#64;{{ form().ldap.upnSuffix.trim() || 'contoso.local' }} ; aussi l'exemple du formulaire</span>
                    </label>
                  }
                </div>

                <div class="guide">
                  <button type="button" class="guide-toggle" [class.open]="ldapAdvancedOpen()" (click)="ldapAdvancedOpen.set(!ldapAdvancedOpen())" [attr.aria-expanded]="ldapAdvancedOpen()">
                    <span class="guide-icon"><wl-nav-icon name="filter" [size]="15" /></span>
                    <span class="guide-title">Filtre de recherche et attributs<span class="muted small">{{ form().ldap.kind === 'ad' ? 'valeurs habituelles d’Active Directory' : 'valeurs habituelles d’OpenLDAP' }}</span></span>
                    <wl-nav-icon class="chev" name="chevron" [size]="15" />
                  </button>
                  @if (ldapAdvancedOpen()) {
                    <div class="ldap-advanced" animate.enter="fade-in">
                      <label class="field">Filtre de recherche des comptes
                        <input class="mono" [ngModel]="form().ldap.userFilter" (ngModelChange)="patchLdap({ userFilter: $event })" spellcheck="false" autocomplete="off" />
                        <span class="muted small">&#123;0&#125; : l'identifiant saisi, échappé (RFC 4515) pour empêcher toute injection</span>
                      </label>
                      <div class="fields">
                        <label class="field">Attribut identifiant
                          <input class="mono" [ngModel]="form().ldap.usernameAttribute" (ngModelChange)="patchLdap({ usernameAttribute: $event })" spellcheck="false" autocomplete="off" />
                          <span class="muted small">Devient l'identifiant Wolflog</span>
                        </label>
                        <label class="field">Nom affiché
                          <input class="mono" [ngModel]="form().ldap.displayNameAttribute" (ngModelChange)="patchLdap({ displayNameAttribute: $event })" spellcheck="false" autocomplete="off" />
                        </label>
                        <label class="field">E-mail
                          <input class="mono" [ngModel]="form().ldap.mailAttribute" (ngModelChange)="patchLdap({ mailAttribute: $event })" spellcheck="false" autocomplete="off" />
                        </label>
                        <label class="field">Groupes
                          <input class="mono" [ngModel]="form().ldap.groupAttribute" (ngModelChange)="patchLdap({ groupAttribute: $event })" spellcheck="false" autocomplete="off" />
                        </label>
                      </div>
                      @if (form().ldap.kind === 'ad') {
                        <label class="check"><input type="checkbox" class="switch" [ngModel]="form().ldap.nestedGroups" (ngModelChange)="patchLdap({ nestedGroups: $event })" />
                          Groupes imbriqués (règle LDAP_MATCHING_RULE_IN_CHAIN)</label>
                      }
                    </div>
                  }
                </div>

                <div class="test-row">
                  <button class="btn" (click)="testLdap()" [disabled]="ldapTesting() || !form().ldap.hosts.trim()">
                    @if (ldapTesting() && !readingBaseDn()) { <span class="spinner"></span> } @else { <wl-nav-icon name="play" [size]="13" /> }
                    {{ ldapTesting() && !readingBaseDn() ? 'Connexion…' : 'Tester la connexion' }}
                  </button>
                  <span class="muted small">Joint l'annuaire avec les réglages ci-dessus, sans rien enregistrer.</span>
                </div>
                @if (ldapReport(); as r) {
                  <ul class="report" animate.enter="fade-in" aria-live="polite">
                    @for (step of r.steps; track step.title) {
                      <li [class]="step.ok === true ? 'ok' : step.ok === false ? 'ko' : 'skip'">
                        <wl-nav-icon [name]="step.ok === true ? 'ok' : step.ok === false ? 'warning' : 'info'" [size]="15" />
                        <span><strong>{{ step.title }}</strong>{{ step.message }}</span>
                      </li>
                    }
                  </ul>
                }

                <div class="account-test">
                  <span class="field-label">Tester un compte</span>
                  <div class="account-fields">
                    <input [(ngModel)]="accountLogin" placeholder="jdupont" autocomplete="off" spellcheck="false" aria-label="Identifiant à tester" />
                    <input type="password" [(ngModel)]="accountPassword" placeholder="Mot de passe" autocomplete="new-password" aria-label="Mot de passe du compte à tester" />
                    <button class="btn" (click)="testAccount()" [disabled]="accountTesting() || !accountLogin.trim() || !accountPassword || !form().ldap.hosts.trim()">
                      @if (accountTesting()) { <span class="spinner"></span> } @else { <wl-nav-icon name="account" [size]="13" /> }
                      Tester
                    </button>
                  </div>
                  <span class="muted small">Le compte trouvé, ses groupes et ce que Wolflog lui donnerait, sans créer le compte.</span>
                  @if (accountReport(); as a) {
                    @if (a.account; as account) {
                      <div class="account-card" animate.enter="fade-in">
                        <div class="account-head"><wl-nav-icon name="ok" [size]="16" /><strong>{{ account.displayName || account.username }}</strong>
                          <span class="mono muted small">{{ account.username }}</span></div>
                        <dl class="facts">
                          <div><dt>DN</dt><dd class="mono">{{ account.dn }}</dd></div>
                          <div><dt>E-mail</dt><dd>{{ account.email || '' }}</dd></div>
                          <div><dt>Dans Wolflog</dt><dd>{{ decisionText(a) }}</dd></div>
                        </dl>
                        <div class="ldap-groups">
                          @for (g of account.groups; track g.dn) {
                            <span class="ldap-group" [class.mapped]="g.mapped" [title]="g.mapped ? g.dn + ' (repris à l’étape 5)' : g.dn">
                              @if (g.mapped) { <wl-nav-icon name="check" [size]="12" /> }<span class="ldap-group-name">{{ g.name }}</span></span>
                          } @empty {
                            <span class="muted small">Aucun groupe.</span>
                          }
                        </div>
                        @if (account.groups.length) {
                          <span class="muted small">Groupes marqués : repris par une correspondance de l’étape 5, telle qu’elle était au moment du test.</span>
                        }
                      </div>
                    } @else {
                      <p class="warn-text small" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" /><span>{{ a.message }}</span></p>
                    }
                  }
                </div>
              </div>
            </section>

            <!-- 4. Comptes -->
            <section class="panel step done">
              <div class="step-head"><span class="num">4</span><h2>Comptes créés à la première connexion</h2></div>
              <div class="step-body">
                <div class="fields">
                  <label class="field">Rôle par défaut
                    <select [ngModel]="form().defaultRole" (ngModelChange)="patch({ defaultRole: $event })">
                      @for (r of roles; track r.value) { <option [value]="r.value" [wlOpt]="r.label" [icon]="r.icon" [tone]="r.tone" [desc]="r.hint"></option> }
                    </select>
                  </label>
                  <label class="field">Profil d'accès par défaut
                    <select [ngModel]="form().defaultProfileId ?? everything" (ngModelChange)="patch({ defaultProfileId: $event === everything ? null : $event })"
                            [disabled]="!profilesReady() && !form().defaultProfileId">
                      @if (!hasEverything()) { <option [value]="everything" wlOpt="Tout voir" icon="eye" desc="Aucun profil : toutes les parties de Wolflog"></option> }
                      @for (p of profileChoices(form().defaultProfileId); track p.id) { <option [value]="p.id" [wlOpt]="p.name" [icon]="p.icon || 'id-card'" [desc]="p.description || ''"></option> }
                    </select>
                    @if (!profilesReady()) { <span class="muted small">Profils d'accès indisponibles pour l'instant.</span> }
                  </label>
                </div>
                <div class="domains-field">
                  <span id="sso-domains">Domaines autorisés</span>
                  <div class="domains" role="group" aria-labelledby="sso-domains">
                    @for (d of form().allowedDomains; track d) {
                      <span class="sso-chip" animate.enter="chip-in" animate.leave="chip-out">{{ d }}
                        <button type="button" (click)="removeDomain(d)" [attr.aria-label]="'Retirer ' + d"><wl-nav-icon name="close" [size]="11" /></button></span>
                    }
                    <input #domainBox (keydown)="domainKey($event, domainBox)" (blur)="addDomain(domainBox)" spellcheck="false" autocomplete="off"
                           [placeholder]="form().allowedDomains.length ? 'Ajouter…' : 'contoso.fr, CONTOSO…'" aria-label="Domaine à autoriser" />
                  </div>
                  <span class="muted small">Vide : tous les comptes du locataire ou du domaine. Microsoft : domaine de l'UPN (jdupont&#64;contoso.fr) ;
                    Windows : domaine NetBIOS (CONTOSO\\jdupont). L'annuaire LDAP choisit déjà ses comptes par son DN de base et son filtre.</span>
                </div>
              </div>
            </section>

            <!-- 5. Groupes -->
            <section class="panel step" [class.done]="form().groupMappings.length > 0">
              <div class="step-head"><span class="num">5</span><h2>Groupes de l'annuaire</h2><span class="hint">rôle et profil d'accès selon les groupes</span></div>
              <div class="step-body">
                <p class="muted small">À chaque connexion : le rôle le plus élevé des groupes trouvés, et le profil du premier groupe de la liste qui en donne un.
                  Dès qu'un groupe donne un rôle, quitter le groupe ramène au rôle par défaut ; sans groupe à rôle, le rôle se règle dans Utilisateurs.</p>
                @if (form().groupMappings.length) {
                  <div class="maps">
                    @for (m of form().groupMappings; track m; let i = $index) {
                      <div class="map" animate.enter="row-in" animate.leave="row-out">
                        <div class="map-group">
                          <input class="mono" [ngModel]="m.group" (ngModelChange)="patchMapping(i, { group: $event })" placeholder="Wolflog-Admins, ID d'objet, DOMAINE\\groupe…"
                                 spellcheck="false" autocomplete="off" aria-label="Groupe" />
                          <input [ngModel]="m.name" (ngModelChange)="patchMapping(i, { name: $event })" placeholder="Nom (facultatif)" autocomplete="off" aria-label="Nom du groupe" />
                        </div>
                        <select [ngModel]="m.role ?? ''" (ngModelChange)="patchMapping(i, { role: $event || null })" aria-label="Rôle donné par ce groupe">
                          <option value="" wlOpt="Rôle inchangé" icon="close" desc="Ce groupe ne donne pas de rôle"></option>
                          @for (r of roles; track r.value) { <option [value]="r.value" [wlOpt]="r.label" [icon]="r.icon" [tone]="r.tone"></option> }
                        </select>
                        <select [ngModel]="m.profileId ?? ''" (ngModelChange)="patchMapping(i, { profileId: $event || null })" aria-label="Profil d'accès donné par ce groupe"
                                [disabled]="!profilesReady() && !m.profileId">
                          <option value="" wlOpt="Profil inchangé" icon="close" desc="Ce groupe ne donne pas de profil"></option>
                          @for (p of profileChoices(m.profileId); track p.id) { <option [value]="p.id" [wlOpt]="p.name" [icon]="p.icon || 'id-card'"></option> }
                        </select>
                        <button type="button" class="btn ghost icon remove" (click)="removeMapping(i)" [attr.aria-label]="'Retirer ' + (m.name || m.group || 'cette ligne')"
                                title="Retirer"><wl-nav-icon name="trash" [size]="14" /></button>
                      </div>
                    }
                  </div>
                }
                <div><button type="button" class="btn" (click)="addMapping()"><wl-nav-icon name="plus" [size]="14" />Ajouter un groupe</button></div>
                <div class="claims">
                  <p><wl-microsoft-logo [size]="13" /><span><b>Microsoft</b> : l'ID d'objet du groupe (Entra ID › Groupes), transmis par la revendication « groups »
                    à activer dans <b>Configuration des jetons</b> (étape 5 du guide). Les rôles d'application (revendication « roles ») sont reconnus aussi.</span></p>
                  <p><wl-nav-icon name="desktop" [size]="13" /><span><b>Windows</b> : DOMAINE\\groupe (ex. CONTOSO\\Wolflog-Admins) ou le SID du groupe.</span></p>
                  <p><wl-nav-icon name="building" [size]="13" /><span><b>Annuaire LDAP / Active Directory</b> : le nom du groupe (ex. Wolflog-Admins) ou son DN
                    complet ; les groupes imbriqués comptent aussi.</span></p>
                </div>
              </div>
            </section>

            <!-- 6. Connexion automatique -->
            <section class="panel step" [class.done]="!!form().autoSignIn">
              <div class="step-head"><span class="num">6</span><h2>Connexion automatique</h2><span class="hint">facultatif</span></div>
              <div class="step-body">
                <div class="seg auto-seg" role="group" aria-label="Connexion automatique">
                  <button type="button" [class.on]="form().autoSignIn === ''" (click)="setAuto('')">Non</button>
                  <button type="button" [class.on]="form().autoSignIn === 'microsoft'" (click)="setAuto('microsoft')" [disabled]="!microsoftOn()">Microsoft</button>
                  <button type="button" [class.on]="form().autoSignIn === 'windows'" (click)="setAuto('windows')" [disabled]="!form().windowsEnabled">Windows</button>
                </div>
                <p class="phrase">{{ autoHint() }}</p>
                <div class="uri"><span class="uri-label">Formulaire local, toujours accessible</span><code>{{ origin }}/login?local=1</code><wl-copy [text]="origin + '/login?local=1'" /></div>
              </div>
            </section>
          </div>

          <aside class="panel summary">
            <div class="block">
              <h3>État</h3>
              <ul class="states">
                <li [class]="microsoftState().tone"><wl-nav-icon [name]="microsoftState().icon" [size]="15" /><span><b>Microsoft</b>{{ microsoftState().text }}</span></li>
                <li [class]="windowsState().tone"><wl-nav-icon [name]="windowsState().icon" [size]="15" /><span><b>Windows</b>{{ windowsState().text }}</span></li>
                <li [class]="ldapState().tone"><wl-nav-icon [name]="ldapState().icon" [size]="15" /><span><b>Annuaire LDAP</b>{{ ldapState().text }}</span></li>
                <li [class]="form().autoSignIn ? 'ok' : 'off'"><wl-nav-icon name="login" [size]="15" /><span><b>Connexion automatique</b>{{ autoLabel() }}</span></li>
              </ul>
              @if (dirty()) { <p class="unsaved small"><wl-nav-icon name="edit" [size]="13" />Modifications non enregistrées</p> }
            </div>
            <div class="block">
              <h3>Page de connexion</h3>
              <div class="mock" aria-hidden="true">
                @if (previewMicrosoft()) { <span class="mock-btn"><wl-microsoft-logo [size]="13" />Se connecter avec {{ previewLabel() }}</span> }
                @if (form().windowsEnabled) { <span class="mock-btn"><wl-nav-icon name="desktop" [size]="13" />Se connecter avec Windows</span> }
                @if (previewMicrosoft() || form().windowsEnabled) { <span class="mock-or">{{ form().ldap.enabled ? 'ou avec votre identifiant' : 'ou avec un compte Wolflog' }}</span> }
                @if (form().ldap.enabled) { <span class="mock-label">Identifiant</span> }
                <span class="mock-field"></span>
                <span class="mock-field short"></span>
              </div>
              @if (form().autoSignIn) {
                <p class="muted small">Redirection immédiate vers {{ form().autoSignIn === 'windows' ? 'Windows' : previewLabel() }}, sauf après une déconnexion.</p>
              } @else if (form().ldap.enabled) {
                <p class="muted small">Le formulaire accepte l'identifiant de l'entreprise ({{ ldapExample() }}) ou un compte Wolflog.</p>
              } @else if (!previewMicrosoft() && !form().windowsEnabled) {
                <p class="muted small">Formulaire Wolflog seul : activez Microsoft, Windows ou l'annuaire pour la connexion de l'entreprise.</p>
              }
            </div>
            @if (v.lastFailure; as f) {
              <div class="block">
                <h3>Dernier échec</h3>
                <p class="failure"><wl-nav-icon name="warning" [size]="14" /><span><b>{{ methodLabel(f.method) }}, {{ f.at | ago }}</b>{{ f.message }}</span></p>
              </div>
            }
            @if (v.settings.updatedAt) {
              <div class="block"><p class="muted small">Modifié {{ v.settings.updatedAt | ago }}{{ v.settings.updatedBy ? ' par ' + v.settings.updatedBy : '' }}.</p></div>
            }
            @if (error()) { <div class="block"><span class="danger small err" role="alert" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span></div> }
            <div class="actions">
              <button class="btn primary" (click)="save()" [disabled]="busy() || !dirty()">
                @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon name="check" [size]="15" /> }
                Enregistrer
              </button>
              @if (dirty()) { <button class="btn ghost" (click)="reset()">Annuler</button> }
            </div>
          </aside>
        </div>
      } @else {
        <div class="form-grid">
          <div class="steps">
            <section class="panel"><wl-skeleton [rows]="6" /></section>
            <section class="panel"><wl-skeleton [rows]="3" /></section>
          </div>
          <aside class="panel"><wl-skeleton [rows]="5" /></aside>
        </div>
      }
    </div>
  `,
  styles: `
    .sso .step > .step-head { flex-wrap: wrap; align-items: center; row-gap: 6px; }
    .title { display: inline-flex; align-items: center; gap: 8px; }
    .title wl-nav-icon { color: var(--accent); }
    .check { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); cursor: pointer; }
    p { margin: 0; }
    code { overflow-wrap: anywhere; }

    /* Champs : grille qui passe sur une colonne quand la place manque, icône dans le champ. */
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 12px 18px; }
    .field select { width: 100%; }
    .control { position: relative; display: block; }
    .control input { width: 100%; padding-left: 32px; }
    .control wl-nav-icon { position: absolute; left: 11px; top: 0; bottom: 0; margin: auto 0; height: 14px; color: var(--text-3); pointer-events: none;
      transition: color .25s, transform .4s var(--spring); }
    .control:focus-within wl-nav-icon { color: var(--accent); transform: translateY(-1px) scale(1.12); }
    .warn-text { display: flex; align-items: flex-start; gap: 6px; color: var(--warn); line-height: 1.45; }
    .warn-text wl-nav-icon { flex: none; margin-top: 2px; }
    .check-line { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--warn); }

    /* Test de l'inscription : une ligne par étape, icône et texte colorés. */
    .test-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
    .report { display: grid; gap: 6px; margin: 0; padding: 10px 12px; list-style: none; border-radius: var(--radius-sm); background: var(--surface-2);
      border: 1px solid var(--border-soft); }
    .report li { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.5; color: var(--text-2); }
    .report li wl-nav-icon { flex: none; margin-top: 2px; }
    .report li strong { margin-right: 6px; color: var(--text-1); font-weight: 600; }
    .report li.ok wl-nav-icon { color: var(--ok); }
    .report li.ko wl-nav-icon, .report li.ko strong { color: var(--danger); }
    .report li.skip wl-nav-icon { color: var(--text-3); }

    /* Guides repliables : la flèche pivote, le contenu glisse. */
    .guide { display: grid; gap: 10px; }
    .guide-toggle { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; text-align: left; cursor: pointer;
      border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-1); font: 550 13px var(--sans);
      transition: border-color .2s, background-color .2s; }
    .guide-toggle:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); background-color: var(--surface-3); }
    .guide-icon { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--accent); background: var(--accent-soft);
      transition: transform .4s var(--spring); }
    .guide-toggle:hover .guide-icon { transform: scale(1.08) rotate(-6deg); }
    .guide-title { flex: 1; display: grid; gap: 1px; min-width: 0; }
    .chev { flex: none; color: var(--text-3); transition: transform .35s var(--spring); }
    .guide-toggle.open .chev { transform: rotate(180deg); }
    .guide-steps { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
    .guide-steps li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; font-size: 12.5px; line-height: 1.6; color: var(--text-2); }
    .guide-steps .n { display: grid; place-items: center; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%; font: 650 11px var(--sans);
      color: var(--accent); background: var(--accent-soft); }
    .guide-steps b { color: var(--text-1); font-weight: 600; }
    /* Libellé anglais du portail, après le libellé français (l'espace entre balises n'est pas conservé par Angular). */
    .guide-steps i { margin-left: .35em; font-style: normal; font-size: 11.5px; color: var(--text-3); }
    .guide-steps a { display: inline-flex; align-items: center; gap: 3px; font-weight: 600; }
    .guide-steps .uri, .guide-steps .warn-text { margin-top: 6px; }
    .guide-end { padding-left: 34px; }

    /* Adresse à copier. */
    .uri { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
    .uri code { padding: 4px 10px; border-radius: 8px; background: var(--code-bg); border: 1px solid var(--border-soft); color: var(--text-1); }
    .uri-label { font-size: 12px; color: var(--text-3); }

    /* Configuration de wolflog.json, en lecture seule. */
    .callout { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 12.5px; line-height: 1.5;
      background: color-mix(in srgb, var(--accent) 9%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent); }
    .callout > wl-nav-icon { flex: none; margin-top: 1px; color: var(--accent); }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 10px 18px; margin: 0; }
    .facts dt { font-size: 11px; color: var(--text-3); }
    .facts dd { margin: 2px 0 0; font-size: 12.5px; overflow-wrap: anywhere; }

    /* Windows : prise en charge par le serveur, prérequis en cartes. */
    .host { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.5; color: var(--ok); }
    .host wl-nav-icon { flex: none; margin-top: 2px; }
    .host.ko { color: var(--warn); }
    .host span { color: var(--text-1); }
    .reqs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 12px; }
    .req { display: grid; gap: 8px; align-content: start; min-width: 0; padding: 12px 14px; border-radius: var(--radius-sm); background: var(--surface-2);
      border: 1px solid var(--border-soft); transition: border-color .2s; }
    .req:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
    .req h3 { display: flex; align-items: center; gap: 7px; }
    .req h3 wl-nav-icon { color: var(--accent); }
    .req p { font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
    .req b { color: var(--text-1); font-weight: 600; }

    /* Domaines autorisés : pastilles locales (aucun style global). */
    .domains-field { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    .domains-field:focus-within > span:first-child { color: var(--accent); }
    .domains { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 36px; padding: 4px 6px; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: var(--surface-2); transition: border-color .25s, box-shadow .35s var(--ease); }
    .domains:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
    .domains input { flex: 1; min-width: 120px; height: 26px; padding: 0 6px; border: 0; background: none; box-shadow: none; }
    .domains input:focus { transform: none; box-shadow: none; background: none; }
    .sso-chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px 0 10px; border-radius: 999px; font: 550 12px var(--mono);
      color: var(--text-1); background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); }
    .sso-chip button { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; background: none;
      color: var(--text-3); cursor: pointer; transition: color .2s, background-color .2s, transform .25s var(--spring); }
    .sso-chip button:hover { color: var(--danger); background-color: color-mix(in srgb, var(--danger) 14%, transparent); transform: scale(1.1); }
    .chip-in { animation: chip-in .35s var(--spring); }
    .chip-out { animation: chip-out .18s ease-in forwards; }
    @keyframes chip-in { from { opacity: 0; transform: scale(.7); } }
    @keyframes chip-out { to { opacity: 0; transform: scale(.7); } }

    /* Correspondances de groupes : une ligne par groupe, empilée quand la place manque. */
    .maps { container-type: inline-size; display: grid; gap: 8px; }
    .map { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) 32px; gap: 8px; align-items: start; padding: 10px;
      border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border-soft); transition: border-color .2s; }
    .map:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
    .map-group { display: grid; gap: 6px; min-width: 0; }
    .map input, .map select { width: 100%; }
    .remove:hover { color: var(--danger); }
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    @container (max-width: 560px) {
      .map { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 32px; }
      .map-group { grid-column: 1 / 3; }
      .map .remove { grid-column: 3; grid-row: 1; }
    }
    /* Téléphone : rôle et profil chacun sur toute la largeur, lisibles en entier. */
    @container (max-width: 400px) {
      .map { grid-template-columns: minmax(0, 1fr) 32px; }
      .map-group { grid-column: 1; }
      .map .remove { grid-column: 2; }
      .map select { grid-column: 1 / -1; }
    }
    .row-in { animation: row-in .35s var(--ease); }
    .row-out { animation: row-out .2s ease-in forwards; }
    @keyframes row-in { from { opacity: 0; transform: translateY(-6px); } }
    @keyframes row-out { to { opacity: 0; transform: translateX(12px); } }
    .claims { display: grid; gap: 6px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .claims p { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.55; color: var(--text-2); }
    .claims wl-microsoft-logo, .claims wl-nav-icon { margin-top: 3px; }
    .claims wl-nav-icon { color: var(--accent); }
    .claims b { color: var(--text-1); font-weight: 600; }

    /* Annuaire LDAP : type et chiffrement en contrôles segmentés, DN de base avec son bouton de lecture, test d'un compte. */
    .field-label { font-size: 12px; color: var(--text-2); }
    .ldap-seg { justify-self: start; max-width: 100%; }
    .ldap-security { display: grid; gap: 8px; justify-items: start; }
    .base-dn { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    .base-dn:focus-within > label { color: var(--accent); }
    .with-action { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .with-action .control { flex: 1 1 260px; min-width: 0; }
    .ldap-advanced { display: grid; gap: 12px; }
    .ldap-advanced .field input { width: 100%; }
    .account-test { display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .account-fields { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .account-fields input { flex: 1 1 180px; min-width: 0; }
    .account-fields .btn { flex: none; }
    .account-card { display: grid; gap: 10px; padding: 12px 14px; border-radius: var(--radius-sm); background: var(--surface-solid); border: 1px solid var(--border); }
    .account-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
    .account-head wl-nav-icon { color: var(--ok); }
    .ldap-groups { display: flex; flex-wrap: wrap; gap: 6px; }
    .ldap-group { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 24px; padding: 0 10px; border-radius: 999px;
      font: 550 12px var(--sans); color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .ldap-group wl-nav-icon { flex: none; }
    .ldap-group-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Groupe repris par une correspondance (étape 5) : coche et couleur d'accent. */
    .ldap-group.mapped { color: var(--text-1); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
    .ldap-group.mapped wl-nav-icon { color: var(--accent); }
    .mock-label { font-size: 10.5px; font-weight: 600; color: var(--text-2); }

    /* Connexion automatique. */
    .auto-seg { justify-self: start; max-width: 100%; }
    .auto-seg button:disabled { opacity: .45; cursor: default; }
    .phrase { font-size: 13px; line-height: 1.55; }

    /* Résumé : états en icônes et texte coloré, aperçu de la page de connexion. */
    .states { display: grid; gap: 8px; margin: 2px 0 0; padding: 0; list-style: none; }
    .states li { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.45; color: var(--text-2); }
    .states li wl-nav-icon { flex: none; margin-top: 1px; }
    .states li b { margin-right: 6px; color: var(--text-1); font-weight: 600; }
    .states li.ok wl-nav-icon { color: var(--ok); }
    .states li.warn wl-nav-icon { color: var(--warn); }
    .states li.off { color: var(--text-3); }
    .states li.off wl-nav-icon { color: var(--text-3); }
    .unsaved { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--accent); }
    .mock { display: grid; gap: 7px; padding: 14px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--border-soft); }
    .mock-btn { display: flex; align-items: center; justify-content: center; gap: 7px; height: 28px; padding: 0 10px; border-radius: 9px; font-size: 11.5px;
      font-weight: 600; color: var(--text-1); background: var(--surface-solid); border: 1px solid var(--border); white-space: nowrap; overflow: hidden; }
    .mock-btn wl-nav-icon { color: var(--accent); }
    .mock-or { font-size: 10.5px; text-align: center; color: var(--text-3); }
    .mock-field { height: 22px; border-radius: 7px; background: var(--surface-3); }
    .mock-field.short { width: 64%; }
    .failure { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.5; color: var(--text-2); overflow-wrap: anywhere; }
    .failure wl-nav-icon { flex: none; margin-top: 2px; color: var(--warn); }
    .failure b { display: block; color: var(--text-1); font-weight: 600; }
    .err { display: flex; align-items: center; gap: 6px; }
    .actions { flex-wrap: wrap; }

    .fade-in { animation: fade-in .35s var(--spring); }
    @keyframes fade-in { from { opacity: 0; transform: translateY(4px) scale(.98); } }
  `,
})
export class AdminSsoPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly roles = ROLES;
  protected readonly origin = location.origin;
  protected readonly spnCommand = 'setspn -S HTTP/wolflog.contoso.fr NOMSERVEUR$';
  protected readonly iisCommand = '# Windows 10/11 : Enable-WindowsOptionalFeature -Online -FeatureName IIS-WindowsAuthentication\n'
    + 'Install-WindowsFeature Web-Windows-Auth\n'
    + '& "$env:windir\\system32\\inetsrv\\appcmd.exe" set config Wolflog -section:system.webServer/security/authentication/windowsAuthentication /enabled:true /commit:apphost\n'
    + '& "$env:windir\\system32\\inetsrv\\appcmd.exe" recycle apppool /apppool.name:Wolflog';

  protected readonly view = signal<SsoAdmin | null>(null);
  protected readonly form = signal<SsoSettingsInput>(toInput({
    microsoftEnabled: false, tenant: null, clientId: null, hasSecret: false, secretUnreadable: false, buttonLabel: 'Microsoft', windowsEnabled: false,
    autoSignIn: '', allowedDomains: [], defaultRole: 'viewer', defaultProfileId: null, groupMappings: [], updatedAt: null, updatedBy: null,
  }));
  /** Formulaire tel qu'enregistré, pour savoir s'il y a des modifications. */
  private readonly saved = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly testing = signal(false);
  protected readonly report = signal<SsoTestReport | null>(null);
  protected readonly guideOpen = signal(false);
  protected readonly windowsGuideOpen = signal(false);
  /** Annuaire LDAP : chiffrements proposés, tests, filtre et attributs repliés. */
  protected readonly ldapSecurity = LDAP_SECURITY;
  protected readonly ldapTesting = signal(false);
  /** Le test en cours lit le DN de base proposé par l'annuaire (« Lire depuis l'annuaire »). */
  protected readonly readingBaseDn = signal(false);
  protected readonly ldapReport = signal<LdapProbeReport | null>(null);
  protected readonly ldapAdvancedOpen = signal(false);
  /** Autorité de certification enregistrée (nom, fin de validité), quand le texte saisi est encore le même. */
  protected readonly savedCa = computed(() => {
    const saved = this.view()?.settings.ldap;
    if (!saved?.caCertificate || saved.caCertificate.trim() !== this.form().ldap.caCertificate.trim()) return null;
    return saved.ca.map((c) => `${c.subject} (jusqu'au ${new Date(c.expires).toLocaleDateString('fr-FR')})`).join(', ') || null;
  });
  protected readonly accountTesting = signal(false);
  protected readonly accountReport = signal<LdapAccountReport | null>(null);
  /** Compte à tester : jamais enregistré, oublié en quittant la page. */
  protected accountLogin = '';
  protected accountPassword = '';
  /** Profils d'accès (liste vide si l'API ne répond pas : le profil par défaut reste « Tout voir »). */
  protected readonly profiles = signal<AccessProfile[]>([]);
  protected readonly profilesReady = signal(false);
  /** « Tout voir » : enregistré comme « aucun profil » pour le profil par défaut, explicite dans une correspondance de groupe. */
  protected readonly everything = EVERYTHING;
  protected readonly hasEverything = computed(() => this.profiles().some((p) => p.id === EVERYTHING));

  protected readonly dirty = computed(() => !!this.view() && JSON.stringify(this.form()) !== this.saved());
  protected readonly buttonLabel = computed(() => this.form().buttonLabel.trim() || 'Microsoft');
  /** Connexion Microsoft proposée après enregistrement (réglée ici, ou par wolflog.json). */
  protected readonly microsoftOn = computed(() => this.form().microsoftEnabled || !!this.view()?.file);
  protected readonly previewMicrosoft = this.microsoftOn;
  protected readonly previewLabel = computed(() => this.view()?.file?.displayName || this.buttonLabel());

  /** Vérification immédiate des champs Microsoft (indicative : le serveur a le dernier mot). */
  protected readonly fieldWarning = computed(() => {
    const f = this.form();
    const tenant = tenantOf(f.tenant);
    if (['common', 'organizations', 'consumers'].includes(tenant)) return `« ${tenant} » ouvrirait Wolflog à tous les comptes Microsoft : indiquez votre locataire.`;
    if (tenant && !GUID.test(tenant) && !DOMAIN.test(tenant)) return 'Locataire : un ID d’annuaire (GUID) ou un domaine, ex. contoso.onmicrosoft.com.';
    if (f.clientId.trim() && !GUID.test(f.clientId.trim())) return 'L’ID d’application (client) est un GUID, sur la page « Vue d’ensemble » de l’inscription.';
    if (f.microsoftEnabled && !this.view()?.settings.hasSecret && !f.clientSecret.trim()) return 'Saisissez le secret client pour activer la connexion Microsoft.';
    return null;
  });

  /** Adresse de retour en http hors localhost : refusée par Microsoft. */
  protected readonly httpWarning = computed(() => {
    const uri = this.view()?.redirectUri;
    if (!uri) return false;
    const url = new URL(uri);
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  });

  /** Wolflog voit une autre adresse que le navigateur (reverse proxy) et aucune adresse publique n'est renseignée. */
  protected readonly proxyWarning = computed(() => {
    const v = this.view();
    if (!v || v.publicUrl) return null;
    const seen = new URL(v.requestRedirectUri).origin;
    return seen !== this.origin ? seen : null;
  });

  protected readonly microsoftState = computed<MethodState>(() => {
    const v = this.view();
    const f = this.form();
    if (v?.file) return { icon: 'file', tone: 'ok', text: `active (wolflog.json, ${v.file.displayName})` };
    if (!f.microsoftEnabled) return { icon: 'close', tone: 'off', text: 'désactivée' };
    if (v?.active.microsoft && v.settings.microsoftEnabled) return { icon: 'ok', tone: 'ok', text: this.dirty() ? 'active, modifiée' : 'active' };
    return { icon: 'warning', tone: 'warn', text: this.dirty() ? 'à enregistrer' : 'à compléter' };
  });

  protected readonly windowsState = computed<MethodState>(() => {
    const v = this.view();
    const f = this.form();
    if (!f.windowsEnabled) return { icon: 'close', tone: 'off', text: v?.windowsHost.supported === false ? 'non prise en charge par ce serveur' : 'désactivée' };
    if (v?.active.windows) return { icon: 'ok', tone: 'ok', text: 'active' };
    return { icon: 'warning', tone: 'warn', text: this.dirty() ? 'à enregistrer' : 'inactive' };
  });

  protected readonly ldapState = computed<MethodState>(() => {
    const v = this.view();
    const l = this.form().ldap;
    if (!l.enabled) return { icon: 'close', tone: 'off', text: 'désactivé' };
    if (v?.active.ldap && v.settings.ldap.enabled) {
      return { icon: 'ok', tone: 'ok', text: this.dirty() ? 'actif, modifié' : l.label.trim() ? `actif (${l.label.trim()})` : 'actif' };
    }
    return { icon: 'warning', tone: 'warn', text: this.dirty() ? 'à enregistrer' : 'à compléter' };
  });

  /** Exemple d'identifiant de l'entreprise, comme sur la page de connexion. */
  protected readonly ldapExample = computed(() => {
    const l = this.form().ldap;
    const domain = l.upnSuffix.trim();
    return l.kind === 'ad' && domain ? `jdupont ou jdupont@${domain}` : 'jdupont';
  });

  /** Un mot de passe du compte de service est enregistré, mais le compte, les serveurs ou le chiffrement ont changé : il ne resservira pas. */
  protected readonly bindPasswordDropped = computed(() => {
    const saved = this.view()?.settings.ldap;
    const l = this.form().ldap;
    return !!saved?.hasBindPassword && !saved.bindPasswordUnreadable && !!l.bindDn.trim() && !l.bindPassword && !keepsBindPassword(saved, l);
  });

  protected readonly autoLabel = computed(() => ({ '': 'non', microsoft: `vers ${this.previewLabel()}`, windows: 'vers Windows' })[this.form().autoSignIn]);

  protected readonly autoHint = computed(() => {
    switch (this.form().autoSignIn) {
      case 'microsoft':
        return 'La page de connexion part aussitôt vers Microsoft. Sur un PC joint à Entra ID, Edge connecte la personne avec sa session Windows, sans rien saisir.';
      case 'windows':
        return 'La page de connexion utilise aussitôt la session Windows : sur un PC du domaine, aucune saisie.';
      default:
        return 'La page de connexion propose les boutons de connexion unique et le formulaire Wolflog.';
    }
  });

  constructor() {
    this.api.ssoSettings().subscribe({
      next: (v) => {
        this.apply(v);
        // Première configuration : le guide du portail Azure est déjà ouvert.
        this.guideOpen.set(!v.file && !v.settings.tenant);
      },
      error: (e) => this.toasts.error(e?.error?.error ?? 'Impossible de lire les réglages de connexion.'),
    });
    this.api.accessProfiles().subscribe({
      next: (list) => {
        this.profiles.set(list);
        this.profilesReady.set(true);
      },
      error: () => this.profilesReady.set(false),
    });
  }

  private apply(v: SsoAdmin) {
    const input = toInput(v.settings);
    this.view.set(v);
    this.form.set(input);
    this.saved.set(JSON.stringify(input));
  }

  protected patch(change: Partial<SsoSettingsInput>) {
    this.form.update((f) => {
      const next = { ...f, ...change };
      // Connexion automatique vers une méthode désactivée : sans objet.
      if ((next.autoSignIn === 'microsoft' && !next.microsoftEnabled && !this.view()?.file) || (next.autoSignIn === 'windows' && !next.windowsEnabled)) {
        next.autoSignIn = '';
      }
      return next;
    });
    this.error.set('');
  }

  protected setAuto(value: SsoAutoSignIn) {
    this.patch({ autoSignIn: value });
  }

  /** Réglages de l'annuaire modifiés ; sans compte de service, pas de mot de passe. */
  protected patchLdap(change: Partial<LdapInput>) {
    const ldap = { ...this.form().ldap, ...change };
    if (!ldap.bindDn.trim()) ldap.bindPassword = '';
    this.patch({ ldap });
  }

  /** Type d'annuaire : filtre et attributs habituels de ce type. */
  protected setLdapKind(kind: LdapKind) {
    if (this.form().ldap.kind !== kind) this.patchLdap({ kind, ...LDAP_PRESETS[kind] });
  }

  /** Chiffrement : le port suit s'il était celui par défaut du choix précédent (un port choisi, ex. 10389, est gardé). */
  protected setLdapSecurity(security: LdapSecurity) {
    const l = this.form().ldap;
    const portOf = (value: LdapSecurity) => LDAP_SECURITY.find((s) => s.value === value)?.port ?? 636;
    this.patchLdap({ security, port: !l.port || l.port === portOf(l.security) ? portOf(security) : l.port });
  }

  protected bindPasswordPlaceholder() {
    const saved = this.view()?.settings.ldap;
    const l = this.form().ldap;
    if (!l.bindDn.trim()) return 'Sans compte de service';
    return saved && keepsBindPassword(saved, l) ? '•••••••• enregistré, laisser vide pour le garder' : 'Mot de passe du compte de service';
  }

  /** Réglages en cours de saisie pour un test de l'annuaire (le secret Microsoft n'y sert pas : il n'est pas envoyé). */
  private ldapTestSettings(): SsoSettingsInput {
    return { ...this.form(), clientSecret: '' };
  }

  /** « Tester la connexion », ou « Lire depuis l'annuaire » : le même test, qui remplit alors le DN de base proposé. */
  protected testLdap(readBaseDn = false) {
    this.ldapTesting.set(true);
    this.readingBaseDn.set(readBaseDn);
    this.ldapReport.set(null);
    this.api.testLdap(this.ldapTestSettings()).subscribe({
      next: (r) => {
        this.ldapTesting.set(false);
        this.readingBaseDn.set(false);
        this.ldapReport.set(r);
        if (readBaseDn && r.baseDn) {
          this.patchLdap({ baseDn: r.baseDn });
          this.toasts.ok(`DN de base lu : ${r.baseDn}`, 'ok');
        } else if (readBaseDn) {
          this.toasts.error('L’annuaire n’a pas donné de DN de base : voir le détail du test.');
        } else if (r.ok) {
          this.toasts.ok(r.server ? `Annuaire joint : ${r.server}` : 'Annuaire joint', 'ok');
        }
      },
      error: (e) => {
        this.ldapTesting.set(false);
        this.readingBaseDn.set(false);
        this.ldapReport.set({ ok: false, baseDn: null, server: null, steps: [{ title: 'Test', ok: false, message: e?.error?.error ?? 'Test impossible.' }] });
      },
    });
  }

  protected readBaseDn() {
    this.testLdap(true);
  }

  /** « Tester un compte » : ce que Wolflog donnerait à cette personne avec les réglages en cours, sans créer le compte. */
  protected testAccount() {
    this.accountTesting.set(true);
    this.accountReport.set(null);
    this.api.testLdapAccount(this.ldapTestSettings(), this.accountLogin.trim(), this.accountPassword).subscribe({
      next: (r) => {
        this.accountTesting.set(false);
        this.accountReport.set(r);
      },
      error: (e) => {
        this.accountTesting.set(false);
        this.accountReport.set({ ok: false, message: e?.error?.error ?? 'Test impossible.' });
      },
    });
  }

  /** Rôle et profil qu'aurait le compte testé, ou la raison du refus. */
  protected decisionText(a: LdapAccountReport): string {
    const d = a.decision;
    if (!d) return '';
    if (d.refusal) {
      const reasons: Record<string, string> = {
        disabled: 'compte désactivé dans Wolflog', conflict: 'un compte local porte déjà ce nom', domain: 'domaine non autorisé', identity: 'identifiant manquant',
      };
      return `Connexion refusée : ${reasons[d.refusal] ?? d.refusal}.`;
    }
    const profile = d.role === 'admin' ? 'voit tout' : `profil ${this.profileName(d.profileId)}`;
    return `${d.isNew ? 'Compte créé à la première connexion' : 'Compte existant'} : ${this.roleLabel(d.role)}, ${profile}.`;
  }

  private profileName(id: string | null): string {
    if (!id || id === EVERYTHING) return 'Tout voir';
    return this.profiles().find((p) => p.id === id)?.name ?? id;
  }

  /** Ligne modifiée sur place : elle garde son identité, la saisie n'est pas interrompue. */
  protected patchMapping(index: number, change: Partial<SsoGroupMapping>) {
    const list = this.form().groupMappings;
    Object.assign(list[index], change);
    this.patch({ groupMappings: [...list] });
  }

  protected addMapping() {
    this.patch({ groupMappings: [...this.form().groupMappings, { group: '', name: '', role: null, profileId: null }] });
  }

  protected removeMapping(index: number) {
    this.patch({ groupMappings: this.form().groupMappings.filter((_, i) => i !== index) });
  }

  /** Domaines saisis (séparés par une virgule, un espace ou Entrée), ajoutés une seule fois chacun. */
  protected addDomain(box: HTMLInputElement) {
    const values = box.value.split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, '').replace(/^\*\./, '').toLowerCase()).filter(Boolean);
    box.value = '';
    if (values.length) this.patch({ allowedDomains: [...new Set([...this.form().allowedDomains, ...values])] });
  }

  protected removeDomain(domain: string) {
    this.patch({ allowedDomains: this.form().allowedDomains.filter((d) => d !== domain) });
  }

  protected domainKey(e: KeyboardEvent, box: HTMLInputElement) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') {
      e.preventDefault();
      this.addDomain(box);
    } else if (e.key === 'Backspace' && !box.value && this.form().allowedDomains.length) {
      this.patch({ allowedDomains: this.form().allowedDomains.slice(0, -1) });
    }
  }

  /** Profils proposés ; un profil enregistré mais absent de la liste (supprimé, ou liste indisponible) reste affiché. */
  protected profileChoices(current: string | null): AccessProfile[] {
    const list = this.profiles();
    if (!current || list.some((p) => p.id === current)) return list;
    if (current === EVERYTHING) return [...list, { id: EVERYTHING, name: 'Tout voir', icon: 'eye', sections: [], builtin: true }];
    return [...list, { id: current, name: this.profilesReady() ? `Profil supprimé (${current})` : current, icon: 'warning', sections: [], builtin: false }];
  }

  protected secretPlaceholder() {
    const s = this.view()?.settings;
    return s?.hasSecret && !s.secretUnreadable ? '•••••••• enregistré, laisser vide pour le garder' : 'Valeur du secret';
  }

  protected roleLabel(role: string) {
    return ROLES.find((r) => r.value === role)?.label ?? role;
  }

  protected methodLabel(method: string) {
    return ({ microsoft: 'Microsoft', windows: 'Windows', oidc: 'OpenID Connect', ldap: 'Annuaire LDAP' } as Record<string, string>)[method] ?? method;
  }

  protected test() {
    const f = this.form();
    this.testing.set(true);
    this.report.set(null);
    this.api.testSso({ tenant: f.tenant.trim(), clientId: f.clientId.trim(), clientSecret: f.clientSecret.trim() }).subscribe({
      next: (r) => {
        this.testing.set(false);
        this.report.set(r);
        if (r.ok) this.toasts.ok('Inscription Microsoft vérifiée', 'ok');
      },
      error: (e) => {
        this.testing.set(false);
        this.report.set({ ok: false, tenantId: null, steps: [{ title: 'Test', ok: false, message: e?.error?.error ?? 'Vérification impossible.' }] });
      },
    });
  }

  protected save() {
    const f = this.form();
    this.busy.set(true);
    this.error.set('');
    this.api.saveSsoSettings({ ...f, groupMappings: f.groupMappings.filter((m) => m.group.trim()) }).subscribe({
      next: (v) => {
        this.busy.set(false);
        this.apply(v);
        this.toasts.ok('Connexion SSO enregistrée', 'sso');
      },
      error: (e) => {
        this.busy.set(false);
        const message = e?.error?.error ?? 'Enregistrement impossible.';
        this.error.set(message);
        this.toasts.error(message);
      },
    });
  }

  protected reset() {
    const v = this.view();
    if (v) this.apply(v);
    this.error.set('');
  }
}
