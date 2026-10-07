/** Connexion unique réglée dans l'interface : Microsoft Entra ID, Windows et création des comptes. */
import { Role } from './accounts';

/**
 * Groupe de l'annuaire donnant un rôle et/ou un profil d'accès : ID d'objet d'un groupe Entra ID, valeur d'un rôle
 * d'application, DOMAINE\groupe ou SID d'un groupe Windows.
 */
export interface SsoGroupMapping {
  group: string;
  /** Nom lisible (facultatif), ex. « Équipe support » pour un ID de groupe. */
  name?: string | null;
  role: Role | null;
  profileId: string | null;
}

/** Connexion automatique depuis la page de connexion : non (''), Microsoft ou Windows. */
export type SsoAutoSignIn = '' | 'microsoft' | 'windows';

/** Réglages enregistrés. Le secret client n'est jamais renvoyé : seulement le fait qu'il existe. */
export interface SsoSettings {
  microsoftEnabled: boolean;
  tenant: string | null;
  clientId: string | null;
  hasSecret: boolean;
  /** Le secret enregistré ne peut plus être déchiffré (clés de chiffrement changées) : à ressaisir. */
  secretUnreadable: boolean;
  buttonLabel: string;
  windowsEnabled: boolean;
  ldap: LdapSettings;
  autoSignIn: SsoAutoSignIn;
  allowedDomains: string[];
  defaultRole: Role;
  defaultProfileId: string | null;
  groupMappings: SsoGroupMapping[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Réglages envoyés au serveur. Secret vide : celui enregistré est conservé. */
export interface SsoSettingsInput {
  microsoftEnabled: boolean;
  tenant: string;
  clientId: string;
  clientSecret: string;
  buttonLabel: string;
  windowsEnabled: boolean;
  ldap: LdapInput;
  autoSignIn: SsoAutoSignIn;
  allowedDomains: string[];
  defaultRole: Role;
  defaultProfileId: string | null;
  groupMappings: SsoGroupMapping[];
}

/** Type d'annuaire : Active Directory, ou LDAP (OpenLDAP et autres) ; il propose le filtre et les attributs. */
export type LdapKind = 'ad' | 'ldap';

/** Chiffrement : LDAPS (TLS dès la connexion, recommandé), StartTLS, ou aucun (mots de passe en clair). */
export type LdapSecurity = 'ldaps' | 'starttls' | 'none';

/** Annuaire LDAP / Active Directory : réglages communs à la lecture et à l'envoi. */
interface LdapCommon {
  enabled: boolean;
  kind: LdapKind;
  /** Nom montré aux personnes (ex. « Contoso »). */
  label: string | null;
  /** Serveurs essayés dans l'ordre, « hôte » ou « hôte:port », séparés par des virgules. */
  hosts: string | null;
  port: number;
  security: LdapSecurity;
  ignoreCertificateErrors: boolean;
  /** Autorité de certification de l'annuaire (PEM), approuvée pour cet annuaire seulement. */
  caCertificate: string | null;
  baseDn: string | null;
  /** Compte de service (DN ou UPN), facultatif. */
  bindDn: string | null;
  /** Active Directory sans compte de service : suffixe UPN ajouté à un identifiant simple. */
  upnSuffix: string | null;
  /** Filtre de recherche du compte, {0} = identifiant saisi. */
  userFilter: string;
  usernameAttribute: string;
  displayNameAttribute: string;
  mailAttribute: string;
  groupAttribute: string;
  /** Active Directory : groupes imbriqués. */
  nestedGroups: boolean;
}

/** Réglages enregistrés. Le mot de passe du compte de service n'est jamais renvoyé : seulement le fait qu'il existe. */
export interface LdapSettings extends LdapCommon {
  /** Autorités lues dans le PEM enregistré : nom et fin de validité. */
  ca: { subject: string; expires: string }[];
  hasBindPassword: boolean;
  /** Le mot de passe enregistré ne peut plus être déchiffré (clés de chiffrement changées) : à ressaisir. */
  bindPasswordUnreadable: boolean;
}

/** Réglages envoyés (champs texte vides plutôt que null). Mot de passe du compte de service vide : celui enregistré est conservé. */
export interface LdapInput extends Omit<LdapCommon, 'label' | 'hosts' | 'caCertificate' | 'baseDn' | 'bindDn' | 'upnSuffix'> {
  label: string;
  hosts: string;
  caCertificate: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  upnSuffix: string;
}

/** Test de connexion à l'annuaire : DN de base proposé (RootDSE), serveur, étapes. */
export interface LdapProbeReport {
  ok: boolean;
  baseDn: string | null;
  server: string | null;
  steps: { title: string; ok: boolean | null; message: string }[];
}

/** Test d'un compte de l'annuaire, sans le créer : ce qu'il donne dans Wolflog. */
export interface LdapAccountReport {
  ok: boolean;
  /** Raison d'un échec, pour l'administrateur. */
  message?: string;
  account?: {
    dn: string;
    username: string;
    displayName: string | null;
    email: string | null;
    /** Groupes (imbriqués compris) : nom court, DN, et repris ou non par une correspondance de groupe (nom ou DN). */
    groups: { name: string; dn: string; mapped: boolean }[];
  };
  decision?: { refusal: string | null; isNew: boolean; role: Role; profileId: string | null };
}

/** Section Oidc de wolflog.json : prioritaire sur les réglages de l'interface, affichée en lecture seule. */
export interface SsoFileConfig {
  authority: string;
  clientId: string;
  displayName: string;
  defaultRole: string;
  groupsClaim: string;
  adminGroups: string[];
  editorGroups: string[];
  /** Le fournisseur est Microsoft (Entra ID). */
  microsoft: boolean;
}

/** Administration > Connexion SSO. */
export interface SsoAdmin {
  settings: SsoSettings;
  /** Méthodes réellement proposées (réglages complets, serveur compatible). */
  active: { microsoft: boolean; windows: boolean; ldap: boolean };
  file: SsoFileConfig | null;
  /** URI de redirection à déclarer dans l'inscription : adresse publique si elle est renseignée, sinon celle de la requête. */
  redirectUri: string;
  /** URI de redirection déduite de l'adresse de la requête (telle que le serveur la voit). */
  requestRedirectUri: string;
  /** Adresse publique de Wolflog (Alertes > Canaux). */
  publicUrl: string | null;
  /** Prise en charge de l'authentification Windows par le serveur web. */
  windowsHost: { supported: boolean; host: 'iis' | 'kestrel' | 'none'; message: string };
  /** Dernier échec de connexion unique depuis le démarrage du serveur. */
  lastFailure: { at: string; method: string; message: string } | null;
}

/** Vérification d'une inscription Entra ID : locataire, puis application et secret. */
export interface SsoTestReport {
  ok: boolean;
  tenantId: string | null;
  /** ok : réussie, en échec, ou null (non vérifiée). */
  steps: { title: string; ok: boolean | null; message: string }[];
}
