using System.Text.RegularExpressions;

namespace Wolflog.Server.Security;

/// <summary>
/// Connexion unique réglée dans l'interface (Administration > Connexion SSO) : Microsoft Entra ID, authentification
/// Windows et règles de création des comptes. Un seul document (id "sso") dans sso.json, sauvegardé avec la configuration.
/// </summary>
public sealed partial class SsoSettings : IEntity
{
    public const string DocumentId = "sso";

    public string Id { get; set; } = DocumentId;

    /// <summary>Microsoft Entra ID (Microsoft 365, Azure AD) en OpenID Connect.</summary>
    public bool MicrosoftEnabled { get; set; }
    /// <summary>Locataire : ID de l'annuaire (GUID) ou domaine (contoso.onmicrosoft.com, contoso.fr).</summary>
    public string? Tenant { get; set; }
    /// <summary>ID d'application (client) de l'inscription Entra ID.</summary>
    public string? ClientId { get; set; }
    /// <summary>Secret client chiffré par Data Protection : jamais en clair sur le disque ni renvoyé à l'interface.</summary>
    public string? ProtectedClientSecret { get; set; }
    /// <summary>Texte du bouton : « Se connecter avec … ».</summary>
    public string ButtonLabel { get; set; } = "Microsoft";

    /// <summary>Authentification Windows intégrée (Kerberos ou NTLM, Active Directory).</summary>
    public bool WindowsEnabled { get; set; }

    /// <summary>Annuaire LDAP / Active Directory : identifiant et mot de passe de l'entreprise dans le formulaire de connexion.</summary>
    public LdapSettings Ldap { get; set; } = new();

    /// <summary>Connexion automatique depuis la page de connexion : "" (non), "microsoft" ou "windows".</summary>
    public string AutoSignIn { get; set; } = "";

    /// <summary>Domaines acceptés (UPN, e-mail ou domaine Windows), ex. contoso.fr ou CONTOSO. Vide = tous.</summary>
    public List<string> AllowedDomains { get; set; } = [];
    /// <summary>Rôle des nouveaux comptes (et des comptes sans groupe correspondant quand des groupes donnent un rôle).</summary>
    public string DefaultRole { get; set; } = Roles.Viewer;
    /// <summary>Profil d'accès des nouveaux comptes (null = tout voir).</summary>
    public string? DefaultProfileId { get; set; }
    /// <summary>Groupes de l'annuaire donnant un rôle et/ou un profil d'accès, réappliqués à chaque connexion.</summary>
    public List<SsoGroupMapping> GroupMappings { get; set; } = [];

    public DateTime? UpdatedAt { get; set; }
    public string? UpdatedBy { get; set; }

    /// <summary>Règles de création et de mise à jour des comptes : les rôles et profils suivent l'annuaire.</summary>
    public SsoProvisioning.Rules Rules() => new(DefaultRole, DefaultProfileId, AllowedDomains, GroupMappings, FollowDirectory: true);

    /// <summary>Adresse OpenID Connect du locataire (cloud Microsoft mondial).</summary>
    public static string AuthorityOf(string tenant) => $"https://login.microsoftonline.com/{Uri.EscapeDataString(tenant)}/v2.0";

    /// <summary>
    /// Locataire saisi : ID (GUID) ou domaine, en minuscules. Une adresse collée telle quelle
    /// (https://login.microsoftonline.com/&lt;locataire&gt;/v2.0) est réduite au locataire.
    /// </summary>
    public static string? NormalizeTenant(string? value)
    {
        var tenant = value?.Trim();
        if (string.IsNullOrEmpty(tenant)) return null;
        if (Uri.TryCreate(tenant, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            tenant = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        tenant = tenant.Trim().ToLowerInvariant();
        return tenant.Length == 0 ? null : tenant;
    }

    /// <summary>Pourquoi le locataire n'est pas utilisable (null s'il est correct).</summary>
    public static string? TenantError(string? tenant) => tenant switch
    {
        null or "" => "Indiquez le locataire : l'ID de l'annuaire (GUID) ou un domaine (ex. contoso.onmicrosoft.com).",
        "common" or "organizations" or "consumers" =>
            $"« {tenant} » ouvrirait Wolflog à tous les comptes Microsoft : indiquez l'ID ou le domaine de votre locataire.",
        _ when Guid.TryParse(tenant, out _) || DnsName().IsMatch(tenant) => null,
        _ => $"« {tenant} » n'est ni un ID d'annuaire (GUID) ni un domaine (ex. contoso.onmicrosoft.com).",
    };

    /// <summary>Domaine autorisé saisi (« @contoso.fr », « *.contoso.fr », « CONTOSO ») : en minuscules, null s'il est invalide.</summary>
    public static string? NormalizeDomain(string? value)
    {
        var domain = value?.Trim().TrimStart('@').ToLowerInvariant();
        if (domain is not null && domain.StartsWith("*.", StringComparison.Ordinal)) domain = domain[2..];
        return string.IsNullOrEmpty(domain) || !DomainOrNetbios().IsMatch(domain) ? null : domain;
    }

    [GeneratedRegex(@"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")]
    private static partial Regex DnsName();

    /// <summary>Domaine DNS (contoso.fr) ou nom NetBIOS (CONTOSO).</summary>
    [GeneratedRegex(@"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")]
    private static partial Regex DomainOrNetbios();
}
