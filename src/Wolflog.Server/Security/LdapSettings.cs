namespace Wolflog.Server.Security;

/// <summary>
/// Annuaire LDAP ou Active Directory : la personne saisit l'identifiant et le mot de passe de l'entreprise dans le
/// formulaire de Wolflog, qui les vérifie auprès de l'annuaire. Rôle, profil et groupes : règles de la connexion unique.
/// </summary>
public sealed class LdapSettings
{
    public const string ActiveDirectory = "ad";
    public const string Generic = "ldap";
    public const string Ldaps = "ldaps";
    public const string StartTls = "starttls";
    public const string Clear = "none";

    public const string AdUserFilter = "(&(objectCategory=person)(objectClass=user)(|(sAMAccountName={0})(userPrincipalName={0})))";
    public const string LdapUserFilter = "(uid={0})";

    public bool Enabled { get; set; }
    /// <summary>ad (Active Directory) ou ldap (OpenLDAP et autres) : filtre et attributs proposés.</summary>
    public string Kind { get; set; } = ActiveDirectory;
    /// <summary>Nom de l'annuaire montré aux personnes (ex. « Contoso »).</summary>
    public string? Label { get; set; }
    /// <summary>Serveurs essayés dans l'ordre, séparés par des virgules (ex. « dc1.contoso.local, dc2.contoso.local:3269 »).</summary>
    public string? Hosts { get; set; }
    public int Port { get; set; } = 636;
    /// <summary>ldaps (TLS dès la connexion, recommandé), starttls, ou none (mots de passe en clair sur le réseau).</summary>
    public string Security { get; set; } = Ldaps;
    /// <summary>Certificat du serveur accepté sans vérification : réservé aux essais.</summary>
    public bool IgnoreCertificateErrors { get; set; }
    /// <summary>
    /// Autorité de certification de l'annuaire (PEM : racine, et intermédiaires si le serveur ne les envoie pas), facultative :
    /// approuvée pour cet annuaire seulement, en plus des autorités du système. Le nom du serveur reste vérifié.
    /// </summary>
    public string? CaCertificate { get; set; }
    /// <summary>DN de base des recherches (ex. DC=contoso,DC=local).</summary>
    public string? BaseDn { get; set; }
    /// <summary>Compte de service (DN ou UPN), facultatif : sans lui, la recherche se fait avec le compte de la personne.</summary>
    public string? BindDn { get; set; }
    /// <summary>Mot de passe du compte de service, chiffré (Data Protection) : jamais renvoyé à l'interface.</summary>
    public string? ProtectedBindPassword { get; set; }
    /// <summary>Active Directory sans compte de service : suffixe ajouté à un identifiant simple (jdupont → jdupont@contoso.local).</summary>
    public string? UpnSuffix { get; set; }
    /// <summary>Filtre de recherche du compte, {0} = identifiant saisi (échappé selon la RFC 4515).</summary>
    public string UserFilter { get; set; } = AdUserFilter;
    /// <summary>Attribut qui devient l'identifiant Wolflog.</summary>
    public string UsernameAttribute { get; set; } = "userPrincipalName";
    public string DisplayNameAttribute { get; set; } = "displayName";
    public string MailAttribute { get; set; } = "mail";
    /// <summary>Attribut des groupes du compte (DN).</summary>
    public string GroupAttribute { get; set; } = "memberOf";
    /// <summary>Active Directory : groupes imbriqués (LDAP_MATCHING_RULE_IN_CHAIN, 1.2.840.113556.1.4.1941).</summary>
    public bool NestedGroups { get; set; } = true;

    public bool IsActiveDirectory() => Kind != Generic;

    /// <summary>Réglages suffisants pour se connecter.</summary>
    public bool IsComplete() => !string.IsNullOrWhiteSpace(Hosts) && !string.IsNullOrWhiteSpace(BaseDn) && UserFilter.Contains("{0}", StringComparison.Ordinal);
}
