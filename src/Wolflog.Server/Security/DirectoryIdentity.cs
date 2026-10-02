using System.Runtime.Versioning;
using System.Security.Claims;
using System.Security.Principal;

namespace Wolflog.Server.Security;

/// <summary>Identité transmise par l'annuaire lors d'une connexion unique (Microsoft Entra ID, OpenID Connect ou Windows).</summary>
/// <param name="Method">microsoft, oidc (wolflog.json) ou windows.</param>
/// <param name="Username">Identifiant du compte Wolflog : UPN (jdupont@contoso.fr) ou DOMAINE\utilisateur.</param>
/// <param name="DisplayName">Nom complet, s'il est transmis.</param>
/// <param name="Email">Adresse e-mail, si elle est transmise (indicative : jamais utilisée pour reconnaître un compte).</param>
/// <param name="Groups">Groupes et rôles d'application, comparés sans tenir compte de la casse.</param>
public sealed record DirectoryIdentity(string Method, string Username, string? DisplayName, string? Email, IReadOnlySet<string> Groups)
{
    /// <summary>Jeton OpenID Connect, revendications non renommées (MapInboundClaims = false).</summary>
    public static DirectoryIdentity? FromOidc(string method, ClaimsPrincipal principal, string groupsClaim)
    {
        string? Claim(string type) => principal.FindFirst(type)?.Value.Trim() is { Length: > 0 } v ? v : null;

        // Identifiant stable : UPN, e-mail, puis sujet. Jamais le nom affiché : ni unique, ni toujours maîtrisé par l'annuaire.
        var username = Claim("preferred_username") ?? Claim("email") ?? Claim("upn") ?? Claim("sub");
        if (username is null) return null;
        var groups = principal.FindAll(groupsClaim).Concat(principal.FindAll("roles"))
            .Select(c => c.Value.Trim()).Where(v => v.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return new DirectoryIdentity(method, username, Claim("name"), Claim("email") ?? (username.Contains('@') ? username : null), groups);
    }

    /// <summary>
    /// Session Windows (Negotiate ou IIS) : DOMAINE\utilisateur, ou utilisateur@ROYAUME sous Linux. Groupes : SID et noms
    /// DOMAINE\groupe sous Windows ; ailleurs, les revendications disponibles (rôles et SID, avec la résolution LDAP).
    /// </summary>
    public static DirectoryIdentity? FromWindows(ClaimsPrincipal principal)
    {
        var name = principal.Identity?.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return null;
        var groups = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (OperatingSystem.IsWindows()) AddWindowsGroups(principal.Identity, groups);
        foreach (var claim in principal.Claims)
            if (claim.Type is ClaimTypes.Role or ClaimTypes.GroupSid or "groups" && claim.Value.Length > 0) groups.Add(claim.Value);
        // Pas d'e-mail ni de nom complet sans interroger l'annuaire : le nom affiché est celui du compte (jdupont).
        return new DirectoryIdentity("windows", name, null, null, groups);
    }

    /// <summary>Nom court du compte : jdupont pour CONTOSO\jdupont ou jdupont@contoso.fr.</summary>
    public string AccountName
    {
        get
        {
            var slash = Username.LastIndexOf('\\');
            return slash >= 0 ? Username[(slash + 1)..] : Username.Split('@')[0];
        }
    }

    [SupportedOSPlatform("windows")]
    private static void AddWindowsGroups(IIdentity? identity, HashSet<string> groups)
    {
        if (identity is not WindowsIdentity { Groups: { } sids }) return;
        foreach (var sid in sids) groups.Add(sid.Value);
        try
        {
            foreach (var account in sids.Translate(typeof(NTAccount), forceSuccess: false)) groups.Add(account.Value);
        }
        catch (SystemException)
        {
            // Contrôleur de domaine injoignable : les correspondances par SID restent possibles.
        }
    }
}
