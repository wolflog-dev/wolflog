using System.Security.Claims;

namespace Wolflog.Server.Security;

/// <summary>
/// Connexion Windows. Quand l'annuaire LDAP a un compte de service, la personne (CONTOSO\jdupont, ou jdupont@CONTOSO.LOCAL par
/// Kerberos sous Linux) y est retrouvée : elle garde un seul compte Wolflog, celui de la connexion par l'annuaire (même
/// identifiant, nom, e-mail), avec ses groupes, y compris sous Linux où Kerberos ne les transmet pas. Sinon, ou si elle n'y est
/// pas, le compte porte l'identifiant Windows, comme avant.
/// </summary>
public sealed class WindowsSignIn(AuthService auth, SsoSettingsStore store, LdapDirectory directory, ILogger<WindowsSignIn> log)
{
    /// <summary>Compte connecté (ou raison du refus) et identifiant retenu, pour les journaux.</summary>
    public async Task<(SsoProvisioning.Result Outcome, string Username)> SignInAsync(ClaimsPrincipal principal, CancellationToken ct)
    {
        var windows = DirectoryIdentity.FromWindows(principal);
        if (windows is null) return (new(null, SsoProvisioning.NoIdentity), "?");
        var rules = store.Current.Rules();
        // Domaines autorisés : ceux de l'identité Windows (CONTOSO, contoso.local), vérifiés avant de la chercher dans l'annuaire.
        if (!SsoProvisioning.DomainAllowed(windows.Username, rules.AllowedDomains)) return (new(null, SsoProvisioning.Domain), windows.Username);
        var identity = await ResolveAsync(windows, principal.FindFirst(ClaimTypes.PrimarySid)?.Value, ct);
        return (SsoProvisioning.Provision(auth.Users, identity, rules), identity.Username);
    }

    /// <summary>Identité de l'annuaire si la personne y est retrouvée (groupes Windows conservés), sinon l'identité Windows.</summary>
    private async Task<DirectoryIdentity> ResolveAsync(DirectoryIdentity windows, string? sid, CancellationToken ct)
    {
        var ldap = store.Current.Ldap;
        if (!ldap.Enabled || !ldap.IsComplete() || string.IsNullOrWhiteSpace(ldap.BindDn) || store.BindPassword(ldap) is not { } password) return windows;
        var outcome = await directory.FindWindowsAccountAsync(ldap, password, windows.Username, sid, ct);
        if (outcome.Account is { } account)
        {
            // Groupes de l'annuaire (nom court et DN), et ceux de Windows (DOMAINE\groupe, SID) : les correspondances déjà
            // réglées pour la connexion Windows restent valables.
            var directoryIdentity = PasswordSignIn.Identity(account);
            return directoryIdentity with { Groups = directoryIdentity.Groups.Union(windows.Groups, StringComparer.OrdinalIgnoreCase).ToHashSet(StringComparer.OrdinalIgnoreCase) };
        }
        if (outcome.Failure is LdapDirectory.Unavailable or LdapDirectory.Misconfigured)
            store.RecordFailure(SsoSchemes.Windows, $"{windows.Username} : annuaire LDAP non consulté ({outcome.Detail}), compte Windows utilisé tel quel.");
        else
            log.LogInformation("Connexion Windows : {User} non retrouvé dans l'annuaire LDAP ({Detail}), compte Windows utilisé tel quel.", windows.Username, outcome.Detail);
        return windows;
    }
}
