using System.Text.RegularExpressions;

namespace Wolflog.Server.Api;

/// <summary>
/// Annuaire LDAP / Active Directory dans Administration > Connexion SSO : réglages saisis (lus et vérifiés), test de la
/// connexion et test d'un compte, avec les réglages en cours de saisie et sans rien enregistrer. Le mot de passe du compte
/// de service n'est jamais renvoyé.
/// </summary>
public static partial class LdapEndpoints
{
    /// <summary>Réglages saisis. Mot de passe du compte de service vide : celui enregistré est conservé.</summary>
    public sealed record LdapInput(bool Enabled, string? Kind, string? Label, string? Hosts, int? Port, string? Security, bool IgnoreCertificateErrors,
        string? BaseDn, string? BindDn, string? BindPassword, string? UpnSuffix, string? UserFilter, string? UsernameAttribute,
        string? DisplayNameAttribute, string? MailAttribute, string? GroupAttribute, bool NestedGroups);

    /// <summary>Test : réglages en cours de saisie (toute la page) ; pour un compte, son identifiant et son mot de passe.</summary>
    public sealed record TestInput(SsoEndpoints.SettingsInput? Settings, string? Username, string? Password);

    /// <summary>Ce qui est vérifié : à l'enregistrement d'un annuaire activé, pour un test de connexion, pour un test de compte.</summary>
    public enum Check
    {
        Save,
        Connection,
        Account,
    }

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9-]*$|^\d+(\.\d+)+$")]
    private static partial Regex AttributeName();

    [GeneratedRegex(@"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", RegexOptions.IgnoreCase)]
    private static partial Regex DnsName();

    extension(WebApplication app)
    {
        public void MapWolflogLdap(RouteGroupBuilder admin)
        {
            var auth = app.Services.GetRequiredService<AuthService>();
            var store = app.Services.GetRequiredService<SsoSettingsStore>();
            var directory = app.Services.GetRequiredService<LdapDirectory>();

            // Connexion, chiffrement, compte de service et DN de base (proposé par l'entrée racine de l'annuaire).
            admin.MapPost("/admin/sso/ldap/test", async (TestInput body, CancellationToken ct) =>
            {
                var (ldap, error) = Read(body.Settings?.Ldap, store.Current.Ldap, store, Check.Connection);
                return ldap is null ? Results.BadRequest(new { error }) : Results.Ok(await directory.ProbeAsync(ldap, store.BindPassword(ldap), ct));
            });

            // Compte d'une personne : DN, nom, e-mail, groupes, et le rôle et le profil que Wolflog donnerait, sans créer le compte.
            admin.MapPost("/admin/sso/ldap/account", async (TestInput body, AccessProfileStore profiles, CancellationToken ct) =>
            {
                var current = store.Current;
                var (ldap, error) = Read(body.Settings?.Ldap, current.Ldap, store, Check.Account);
                if (ldap is null) return Results.BadRequest(new { error });
                if (string.IsNullOrWhiteSpace(body.Username) || string.IsNullOrEmpty(body.Password))
                    return Results.BadRequest(new { error = "Saisissez l'identifiant et le mot de passe du compte à tester." });
                var outcome = await directory.AuthenticateAsync(ldap, store.BindPassword(ldap), body.Username, body.Password, ct);
                if (outcome.Account is not { } account) return Results.Ok(new { ok = false, message = Explain(outcome) });
                var rules = body.Settings is null ? current.Rules() : RulesOf(body.Settings, current, profiles);
                // Groupe repris par une correspondance : par son nom court ou son DN complet, sans tenir compte de la casse (comme à la connexion).
                var mapped = rules.Groups.Select(m => m.Group.Trim()).ToHashSet(StringComparer.OrdinalIgnoreCase);
                return Results.Ok(new
                {
                    ok = true,
                    account = new
                    {
                        account.Dn, account.Username, account.DisplayName, account.Email,
                        groups = account.GroupDns
                            .Select(dn => (Name: LdapDirectory.CommonName(dn), Dn: dn))
                            .OrderBy(g => g.Name, StringComparer.OrdinalIgnoreCase)
                            .Select(g => new { name = g.Name, dn = g.Dn, mapped = mapped.Contains(g.Name) || mapped.Contains(g.Dn) }),
                    },
                    decision = SsoProvisioning.Preview(auth.Users, PasswordSignIn.Identity(account), rules),
                });
            });
        }
    }

    /// <summary>Réglages saisis, normalisés (valeurs par défaut du type d'annuaire), puis vérifiés selon l'usage.</summary>
    public static (LdapSettings? Settings, string? Error) Read(LdapInput? input, LdapSettings current, SsoSettingsStore store, Check check)
    {
        LdapSettings ldap;
        if (input is null)
        {
            ldap = current;
        }
        else
        {
            var generic = input.Kind == LdapSettings.Generic;
            var security = input.Security is LdapSettings.StartTls or LdapSettings.Clear ? input.Security : LdapSettings.Ldaps;
            var bindDn = Text(input.BindDn);
            ldap = new LdapSettings
            {
                Enabled = input.Enabled,
                Kind = generic ? LdapSettings.Generic : LdapSettings.ActiveDirectory,
                Label = Text(input.Label),
                Hosts = Text(input.Hosts),
                Port = input.Port is > 0 and < 65536 ? input.Port.Value : security == LdapSettings.Ldaps ? 636 : 389,
                Security = security,
                IgnoreCertificateErrors = input.IgnoreCertificateErrors,
                BaseDn = Text(input.BaseDn),
                BindDn = bindDn,
                // Saisi : chiffré. Vide : celui enregistré (jamais renvoyé), si la cible n'a pas changé (plus bas). Sans compte de service : oublié.
                ProtectedBindPassword = bindDn is null ? null
                    : string.IsNullOrEmpty(input.BindPassword) ? current.ProtectedBindPassword
                    : store.ProtectBindPassword(input.BindPassword),
                UpnSuffix = Text(input.UpnSuffix)?.TrimStart('@'),
                UserFilter = Text(input.UserFilter) ?? (generic ? LdapSettings.LdapUserFilter : LdapSettings.AdUserFilter),
                UsernameAttribute = Text(input.UsernameAttribute) ?? (generic ? "uid" : "userPrincipalName"),
                DisplayNameAttribute = Text(input.DisplayNameAttribute) ?? (generic ? "cn" : "displayName"),
                MailAttribute = Text(input.MailAttribute) ?? "mail",
                GroupAttribute = Text(input.GroupAttribute) ?? "memberOf",
                NestedGroups = input.NestedGroups,
            };
            // Le mot de passe enregistré ne part que vers le compte, les serveurs et le niveau de chiffrement pour lesquels il a été
            // saisi : un administrateur ne peut pas l'envoyer à un autre serveur (ou en clair) sans le connaître.
            if (ldap.ProtectedBindPassword is not null && string.IsNullOrEmpty(input.BindPassword) && !SameTarget(ldap, current))
            {
                ldap.ProtectedBindPassword = null;
                if (check != Check.Save || ldap.Enabled)
                    return (null, "Saisissez de nouveau le mot de passe du compte de service : le mot de passe enregistré ne sert qu'au même compte, "
                        + "sur les mêmes serveurs, sans chiffrement affaibli.");
            }
        }
        // Annuaire désactivé : enregistré tel quel (brouillon).
        if (check == Check.Save && !ldap.Enabled) return (ldap, null);
        return Problem(ldap, check, store) is { } error ? (null, error) : (ldap, null);
    }

    /// <summary>
    /// Même compte de service, mêmes serveurs et ports, et connexion pas plus exposée qu'avant (ni passage en clair, ni certificat
    /// désormais ignoré) : le mot de passe enregistré peut resservir.
    /// </summary>
    private static bool SameTarget(LdapSettings next, LdapSettings current)
    {
        static bool Encrypted(LdapSettings l) => l.Security != LdapSettings.Clear;
        static bool Verified(LdapSettings l) => Encrypted(l) && !l.IgnoreCertificateErrors;
        if (!string.Equals(next.BindDn, current.BindDn, StringComparison.OrdinalIgnoreCase)) return false;
        if ((Encrypted(current) && !Encrypted(next)) || (Verified(current) && !Verified(next))) return false;
        var before = LdapDirectory.Servers(current.Hosts, current.Port);
        var after = LdapDirectory.Servers(next.Hosts, next.Port);
        return before is not null && after is not null && before.Count == after.Count
            && before.Zip(after).All(p => string.Equals(p.First.Host, p.Second.Host, StringComparison.OrdinalIgnoreCase) && p.First.Port == p.Second.Port);
    }

    /// <summary>Réglages (sans le mot de passe du compte de service) pour l'interface.</summary>
    public static object View(LdapSettings l, SsoSettingsStore store) => new
    {
        l.Enabled, l.Kind, l.Label, l.Hosts, l.Port, l.Security, l.IgnoreCertificateErrors, l.BaseDn, l.BindDn,
        hasBindPassword = !string.IsNullOrEmpty(l.ProtectedBindPassword),
        bindPasswordUnreadable = !string.IsNullOrEmpty(l.ProtectedBindPassword) && store.BindPassword(l) is null,
        l.UpnSuffix, l.UserFilter, l.UsernameAttribute, l.DisplayNameAttribute, l.MailAttribute, l.GroupAttribute, l.NestedGroups,
    };

    private static string? Problem(LdapSettings l, Check check, SsoSettingsStore store)
    {
        var servers = LdapDirectory.Servers(l.Hosts, l.Port);
        if (servers is null)
            return "Serveur de l'annuaire invalide : un nom d'hôte ou une adresse IP, éventuellement suivi de :port (ex. dc1.contoso.local, dc2.contoso.local:636).";
        if (servers.Count == 0) return "Indiquez le serveur de l'annuaire (ex. dc1.contoso.local).";
        if (check == Check.Connection) return null;
        if (string.IsNullOrWhiteSpace(l.BaseDn) || !l.BaseDn.Contains('='))
            return "Indiquez le DN de base (ex. DC=contoso,DC=local) : « Tester la connexion » le lit dans l'annuaire.";
        if (!l.UserFilter.Contains("{0}", StringComparison.Ordinal) || !Balanced(l.UserFilter))
            return "Le filtre de recherche doit être entre parenthèses et contenir {0}, remplacé par l'identifiant saisi.";
        foreach (var (label, value) in new[] { ("identifiant", l.UsernameAttribute), ("nom affiché", l.DisplayNameAttribute), ("e-mail", l.MailAttribute), ("groupes", l.GroupAttribute) })
            if (!AttributeName().IsMatch(value)) return $"Attribut « {label} » invalide : « {value} ».";
        if (l.UpnSuffix is not null && !DnsName().IsMatch(l.UpnSuffix)) return $"Suffixe UPN invalide : « {l.UpnSuffix} » (ex. contoso.local).";
        if (l.BindDn is not null)
        {
            if (l.ProtectedBindPassword is null) return "Indiquez le mot de passe du compte de service.";
            if (store.BindPassword(l) is null)
                return "Le mot de passe du compte de service enregistré ne peut plus être déchiffré (clés de chiffrement changées) : saisissez-le de nouveau.";
        }
        return null;
    }

    /// <summary>Filtre entre parenthèses, équilibrées.</summary>
    private static bool Balanced(string filter)
    {
        if (!filter.StartsWith('(') || !filter.EndsWith(')')) return false;
        var depth = 0;
        foreach (var c in filter)
        {
            depth += c switch { '(' => 1, ')' => -1, _ => 0 };
            if (depth < 0) return false;
        }
        return depth == 0;
    }

    /// <summary>Règles en cours de saisie (rôle et profil par défaut, groupes), lues avec indulgence pour un test.</summary>
    private static SsoProvisioning.Rules RulesOf(SsoEndpoints.SettingsInput body, SsoSettings current, AccessProfileStore profiles)
    {
        var mappings = (body.GroupMappings ?? [])
            .Where(m => !string.IsNullOrWhiteSpace(m.Group))
            .Select(m => new SsoGroupMapping
            {
                Group = m.Group.Trim(),
                Role = Roles.IsValid(m.Role) ? m.Role : null,
                ProfileId = string.IsNullOrWhiteSpace(m.ProfileId) ? null : m.ProfileId.Trim(),
            })
            .ToList();
        var defaultProfile = profiles.TryResolve(body.DefaultProfileId ?? "", out var resolved) ? resolved : current.DefaultProfileId;
        return new(Roles.IsValid(body.DefaultRole) ? body.DefaultRole! : current.DefaultRole, defaultProfile, current.AllowedDomains, mappings, FollowDirectory: true);
    }

    /// <summary>Échec d'un test de compte, pour l'administrateur : la raison et le détail donné par l'annuaire.</summary>
    private static string Explain(LdapDirectory.Outcome outcome)
    {
        var reason = outcome.Failure switch
        {
            LdapDirectory.PasswordChange => "Mot de passe expiré ou à changer",
            LdapDirectory.Locked => "Compte verrouillé",
            LdapDirectory.Unavailable => "Annuaire injoignable",
            LdapDirectory.Misconfigured => "Configuration à revoir",
            _ => "Identifiant ou mot de passe refusé",
        };
        return outcome.Detail is null ? reason + "." : $"{reason} : {outcome.Detail}.";
    }

    private static string? Text(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
