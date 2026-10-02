/** Comptes, rôles, clés API et session. */
export type Role = 'viewer' | 'editor' | 'admin';

export interface UserAccount {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  /** Profil d'accès (null : tout voir) ; sans effet pour un administrateur. */
  profileId?: string | null;
  /** Services visibles propres au compte : null = ceux du profil ; [] = tous ; sinon noms ou motifs (« boutique-* »). */
  services?: string[] | null;
  /** local (mot de passe Wolflog), sso (Microsoft, Windows, OpenID Connect) ou ldap (annuaire de l'entreprise). */
  source: 'local' | 'sso' | 'ldap';
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  kind: 'server' | 'browser' | 'read';
  prefix: string;
  allowedOrigins: string[];
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Me {
  authEnabled: boolean;
  authenticated: boolean;
  user: string | null;
  displayName: string | null;
  role: Role | null;
  source: 'local' | 'sso' | 'ldap' | null;
  mustChangePassword: boolean;
  /** Connexion unique ou annuaire proposés sur la page de connexion (null : aucun). */
  sso: {
    /** Texte du bouton OpenID Connect (« Microsoft ») ; « Windows », ou « l'annuaire Contoso », sans bouton OpenID Connect. */
    name: string;
    /** Bouton « Se connecter avec Microsoft » (Microsoft Entra ID). */
    microsoft: boolean;
    /** Autre fournisseur OpenID Connect (section Oidc de wolflog.json) : bouton générique. */
    oidc?: boolean;
    /** Bouton « Se connecter avec Windows » (authentification Windows intégrée). */
    windows: boolean;
    /** Annuaire LDAP / Active Directory : le formulaire accepte l'identifiant et le mot de passe de l'entreprise. */
    ldap?: boolean;
    /** Nom de l'annuaire (ex. « Contoso »). */
    ldapLabel?: string | null;
    /** Domaine des identifiants de l'entreprise, pour l'exemple du formulaire (jdupont@contoso.fr). */
    ldapDomain?: string | null;
    /** Connexion automatique : la page de connexion part aussitôt vers ce fournisseur (/login?local=1 l'évite). */
    autoRedirect: 'microsoft' | 'windows' | null;
  } | null;
  /**
   * Parties de Wolflog accessibles (profil d'accès), dans l'ordre de la navigation ; toutes pour un administrateur.
   * Absent (serveur antérieur) : tout. Vide : aucune (profil introuvable), seul « Mon compte » reste ouvert.
   */
  sections?: string[];
  /** Page d'accueil du profil : la partie ouverte en arrivant sur Wolflog. */
  home?: string | null;
  /** Profil d'accès de l'utilisateur (« Tout voir » sans profil ; null pour un administrateur, qui voit tout). */
  profile?: { id: string; name: string } | null;
  /** Services visibles (noms ou motifs « boutique-* ») ; null ou absent : tous. */
  services?: string[] | null;
}

/** Profil d'accès : ensemble nommé de parties de Wolflog visibles (ex. Produit : audience et clics). */
export interface AccessProfile {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  /** Identifiants des parties visibles (overview, dashboards, logs, requests, traces, errors, metrics, map, profiles, audience, clickmaps, alerts, uptime, slos). */
  sections: string[];
  /** Page d'accueil : l'une des parties visibles (par défaut, la première). */
  home?: string | null;
  /** Services visibles : noms ou motifs avec * (« boutique-* ») ; vide ou absent : tous. Toujours vide pour « Tout voir ». */
  services?: string[];
  /** Profil fourni par Wolflog (modifiable, non supprimable). « all » (Tout voir) donne toujours accès à tout. */
  builtin: boolean;
  /** Nombre d'utilisateurs ayant ce profil (lecture seule). */
  users?: number;
}
