using System.Net.Sockets;
using System.Security.Authentication;
using System.Text.RegularExpressions;
using Novell.Directory.Ldap;

namespace Wolflog.Server.Security;

/// <summary>
/// Annuaire LDAP / Active Directory, par un client entièrement managé (rien à installer sous Linux ni dans Docker) :
/// vérifie l'identifiant et le mot de passe d'une personne, lit son compte et ses groupes, et teste la connexion pour
/// l'administrateur. Chaque appel réseau a un délai ; les mots de passe ne sont jamais journalisés.
/// </summary>
public sealed partial class LdapDirectory(ILogger<LdapDirectory> log)
{
    /// <summary>Compte lu dans l'annuaire.</summary>
    public sealed record Account(string Dn, string Username, string? DisplayName, string? Email, IReadOnlyList<string> GroupDns);

    /// <summary>Compte, ou raison du refus (pour la page de connexion) et détail (pour l'administrateur, jamais de mot de passe).</summary>
    public sealed record Outcome(Account? Account, string? Failure, string? Detail);

    /// <summary>Test de connexion : DN de base proposé par l'annuaire (RootDSE), description du serveur, étapes.</summary>
    public sealed record Probe(bool Ok, string? BaseDn, string? Server, List<CheckStep> Steps);

    // Raisons d'un refus. Identifiants : y compris compte inconnu ou désactivé, que rien ne doit trahir à la personne.
    public const string Credentials = "credentials";
    public const string PasswordChange = "password-change";
    public const string Locked = "locked";
    public const string Unavailable = "unavailable";
    public const string Misconfigured = "config";

    private const string InChainRule = "1.2.840.113556.1.4.1941";
    private const string ActiveDirectoryCapability = "1.2.840.113556.1.4.800";
    private static readonly TimeSpan OperationTimeout = TimeSpan.FromSeconds(10);
    private static readonly string[] RootAttributes =
        ["defaultNamingContext", "namingContexts", "dnsHostName", "vendorName", "vendorVersion", "supportedCapabilities"];

    [GeneratedRegex(@"\bdata ([0-9a-f]{3,8})\b", RegexOptions.IgnoreCase)]
    private static partial Regex AdSubCode();

    [GeneratedRegex(@"^([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$", RegexOptions.IgnoreCase)]
    private static partial Regex HostName();

    /// <summary>
    /// Vérifie l'identifiant (jdupont, jdupont@contoso.fr ou CONTOSO\jdupont) et le mot de passe. Avec un compte de service :
    /// recherche du compte, puis liaison avec son DN. Sans : Active Directory accepte la liaison par UPN (suffixe configuré),
    /// un autre annuaire est d'abord interrogé en anonyme.
    /// </summary>
    public async Task<Outcome> AuthenticateAsync(LdapSettings s, string? bindPassword, string login, string password, CancellationToken ct)
    {
        login = login.Trim();
        // Un mot de passe vide ferait une liaison anonyme… réussie : refusé avant tout échange.
        if (string.IsNullOrEmpty(password)) return new(null, Credentials, "mot de passe vide, refusé sans interroger l'annuaire");
        if (login.Length is 0 or > 256) return new(null, Credentials, "identifiant vide ou trop long");
        if (!string.IsNullOrWhiteSpace(s.BindDn) && string.IsNullOrEmpty(bindPassword))
            return new(null, Misconfigured, "mot de passe du compte de service manquant ou illisible : saisissez-le de nouveau");
        using var timeout = Deadline(ct);
        try
        {
            using var connection = await ConnectAsync(s, timeout.Token);
            var lookup = LookupName(s, login);
            LdapEntry entry;
            if (!string.IsNullOrWhiteSpace(s.BindDn))
            {
                if (await TryBindAsync(connection, s.BindDn.Trim(), bindPassword!, timeout.Token) is { } refused)
                    return new(null, Misconfigured, $"compte de service refusé par l'annuaire ({Describe(refused)})");
                var (found, problem) = await FindAsync(connection, s, lookup, timeout.Token);
                if (problem is not null) return problem;
                if (found is null) return new(null, Credentials, $"« {login} » introuvable dans l'annuaire");
                if (IsDisabled(s, found)) return new(null, Credentials, $"{found.Dn} : compte désactivé dans l'annuaire");
                if (await TryBindAsync(connection, found.Dn, password, timeout.Token) is { } denied) return Refused(denied, found.Dn);
                entry = found;
            }
            else if (s.IsActiveDirectory())
            {
                var name = BindName(s, login);
                if (await TryBindAsync(connection, name, password, timeout.Token) is { } denied) return Refused(denied, name);
                var (found, problem) = await FindAsync(connection, s, lookup, timeout.Token);
                if (problem is not null) return problem;
                if (found is null)
                    return new(null, Misconfigured, $"liaison de « {name} » acceptée, mais compte introuvable sous {s.BaseDn} : vérifiez le DN de base et le filtre");
                entry = found;
            }
            else
            {
                // Autre annuaire sans compte de service : recherche anonyme du compte, puis liaison avec son DN.
                var (found, problem) = await FindAsync(connection, s, lookup, timeout.Token);
                if (problem is not null) return problem;
                if (found is null) return new(null, Credentials, $"« {login} » introuvable dans l'annuaire");
                if (await TryBindAsync(connection, found.Dn, password, timeout.Token) is { } denied) return Refused(denied, found.Dn);
                entry = found;
            }
            var groups = await GroupsAsync(connection, s, entry, timeout.Token);
            return new(ToAccount(s, entry, lookup, groups), null, null);
        }
        catch (LdapException ex)
        {
            return Fault(ex);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new(null, Unavailable, "l'annuaire n'a pas répondu à temps");
        }
    }

    /// <summary>
    /// Compte d'une personne connectée par Windows, cherché avec le compte de service : par son nom de compte et son SID quand
    /// Windows le transmet (serveur Windows), sinon par son nom de compte dans le domaine de son royaume Kerberos
    /// (jdupont@CONTOSO.LOCAL, serveur Linux). Jamais un homonyme d'un autre domaine de la forêt.
    /// </summary>
    public async Task<Outcome> FindWindowsAccountAsync(LdapSettings s, string bindPassword, string windowsName, string? sid, CancellationToken ct)
    {
        var slash = windowsName.IndexOf('\\');
        var at = windowsName.LastIndexOf('@');
        var account = slash > 0 ? windowsName[(slash + 1)..] : at > 0 ? windowsName[..at] : windowsName;
        var realm = slash < 0 && at > 0 ? windowsName[(at + 1)..] : null;
        if (account.Length == 0 || (sid is null && realm is null)) return new(null, Credentials, $"« {windowsName} » : domaine du compte invérifiable (ni SID ni royaume Kerberos)");
        using var timeout = Deadline(ct);
        try
        {
            using var connection = await ConnectAsync(s, timeout.Token);
            if (await TryBindAsync(connection, s.BindDn!.Trim(), bindPassword, timeout.Token) is { } refused)
                return new(null, Misconfigured, $"compte de service refusé par l'annuaire ({Describe(refused)})");
            var filter = s.UserFilter.Replace("{0}", EscapeFilterValue(account), StringComparison.Ordinal);
            if (sid is not null) filter = $"(&{filter}(objectSid={EscapeFilterValue(sid)}))";
            var found = await SearchAsync(connection, s.BaseDn!.Trim(), LdapConnection.ScopeSub, filter, AccountAttributes(s), 2, timeout.Token);
            if (found.Count != 1)
                return new(null, Credentials, found.Count == 0 ? $"« {windowsName} » introuvable dans l'annuaire" : $"plusieurs comptes correspondent à « {windowsName} »");
            var entry = found[0];
            if (sid is null && !string.Equals(DnsDomain(entry.Dn), realm, StringComparison.OrdinalIgnoreCase))
                return new(null, Credentials, $"{entry.Dn} : domaine différent du royaume Kerberos {realm}");
            if (IsDisabled(s, entry)) return new(null, Credentials, $"{entry.Dn} : compte désactivé dans l'annuaire");
            var groups = await GroupsAsync(connection, s, entry, timeout.Token);
            return new(ToAccount(s, entry, account, groups), null, null);
        }
        catch (LdapException ex)
        {
            return Fault(ex);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new(null, Unavailable, "l'annuaire n'a pas répondu à temps");
        }
    }

    /// <summary>Test de connexion : serveur joignable, chiffrement, compte de service (ou lecture anonyme), RootDSE, DN de base.</summary>
    public async Task<Probe> ProbeAsync(LdapSettings s, string? bindPassword, CancellationToken ct)
    {
        var steps = new List<CheckStep>();
        using var timeout = Deadline(ct);
        LdapConnection connection;
        try
        {
            connection = await ConnectAsync(s, timeout.Token);
        }
        catch (Exception ex) when (ex is LdapException or OperationCanceledException)
        {
            steps.Add(new("Connexion", false, Explain(ex)));
            return new(false, null, null, steps);
        }
        using (connection)
        {
            steps.Add(new("Connexion", true, $"{connection.Host}:{connection.Port} répond."));
            steps.Add(s.Security switch
            {
                LdapSettings.Ldaps => new("Chiffrement", true, "LDAPS : TLS dès la connexion."),
                LdapSettings.StartTls => new("Chiffrement", true, "StartTLS négocié."),
                _ => new("Chiffrement", null, "Aucun : identifiants et mots de passe circulent en clair sur le réseau. À réserver aux essais."),
            });
            try
            {
                if (!string.IsNullOrWhiteSpace(s.BindDn))
                {
                    if (string.IsNullOrEmpty(bindPassword))
                    {
                        steps.Add(new("Compte de service", false, "Mot de passe du compte de service manquant ou illisible : saisissez-le de nouveau."));
                        return new(false, null, null, steps);
                    }
                    if (await TryBindAsync(connection, s.BindDn.Trim(), bindPassword, timeout.Token) is { } refused)
                    {
                        steps.Add(new("Compte de service", false, $"Refusé par l'annuaire : vérifiez le DN (ou l'UPN) et le mot de passe ({Describe(refused)})."));
                        return new(false, null, null, steps);
                    }
                    steps.Add(new("Compte de service", true, $"{s.BindDn.Trim()} accepté."));
                }
                else
                {
                    steps.Add(new("Compte de service", null, s.IsActiveDirectory()
                        ? "Aucun : chaque personne cherchera son propre compte, après une liaison par UPN."
                        : "Aucun : les comptes seront cherchés en anonyme."));
                }

                var root = (await SearchAsync(connection, "", LdapConnection.ScopeBase, "(objectClass=*)", RootAttributes, 1, timeout.Token)).FirstOrDefault();
                var suggested = root is null ? null : First(root, "defaultNamingContext") ?? Values(root, "namingContexts")?.FirstOrDefault();
                var server = root is null ? null : ServerName(root);
                steps.Add(root is null
                    ? new("Annuaire", false, "Entrée racine (RootDSE) illisible.")
                    : new("Annuaire", true, suggested is null ? $"{server}." : $"{server}, DN de base {suggested}."));

                if (string.IsNullOrWhiteSpace(s.BaseDn))
                {
                    steps.Add(new("DN de base", null, suggested is null ? "À renseigner." : $"Proposé par l'annuaire : {suggested}."));
                }
                else if (string.IsNullOrWhiteSpace(s.BindDn) && s.IsActiveDirectory())
                {
                    // Active Directory refuse toute recherche anonyme hors de l'entrée racine. À la connexion, la recherche suit la
                    // liaison de la personne : le DN de base se vérifie donc avec « Tester un compte ».
                    var baseDn = s.BaseDn.Trim();
                    var other = suggested is not null && !baseDn.EndsWith(suggested, StringComparison.OrdinalIgnoreCase) ? $" Proposé par l'annuaire : {suggested}." : "";
                    steps.Add(new("DN de base", null, $"{baseDn} : vérifié au test d'un compte (Active Directory refuse la recherche anonyme).{other}"));
                }
                else
                {
                    try
                    {
                        var found = await SearchAsync(connection, s.BaseDn.Trim(), LdapConnection.ScopeBase, "(objectClass=*)", ["1.1"], 1, timeout.Token);
                        steps.Add(new("DN de base", found.Count > 0, found.Count > 0 ? $"{s.BaseDn.Trim()} trouvé." : $"{s.BaseDn.Trim()} introuvable."));
                    }
                    catch (LdapException ex) when (ex.ResultCode == LdapException.NoSuchObject)
                    {
                        steps.Add(new("DN de base", false, $"{s.BaseDn.Trim()} introuvable dans l'annuaire{(suggested is null ? "" : $" (proposé : {suggested})")}."));
                    }
                }
                return new(steps.All(step => step.Ok != false), suggested, server, steps);
            }
            catch (Exception ex) when (ex is LdapException or OperationCanceledException)
            {
                steps.Add(new("Annuaire", false, Explain(ex)));
                return new(false, null, null, steps);
            }
        }
    }

    /// <summary>Valeur insérée dans un filtre LDAP, échappée selon la RFC 4515 (* ( ) \ et NUL) : aucune injection possible.</summary>
    public static string EscapeFilterValue(string value)
    {
        var escaped = new StringBuilder(value.Length + 8);
        foreach (var c in value)
        {
            switch (c)
            {
                case '*': escaped.Append(@"\2a"); break;
                case '(': escaped.Append(@"\28"); break;
                case ')': escaped.Append(@"\29"); break;
                case '\\': escaped.Append(@"\5c"); break;
                case '\0': escaped.Append(@"\00"); break;
                default: escaped.Append(c); break;
            }
        }
        return escaped.ToString();
    }

    /// <summary>Nom court d'un groupe : la valeur du premier élément de son DN (CN=Wolflog-Admins,OU=… → Wolflog-Admins).</summary>
    public static string CommonName(string dn)
    {
        var start = dn.IndexOf('=');
        if (start < 0) return dn.Trim();
        var value = new StringBuilder();
        for (var i = start + 1; i < dn.Length; i++)
        {
            var c = dn[i];
            if (c is ',' or '+') break;
            if (c == '\\' && i + 1 < dn.Length)
            {
                // Caractère échappé : \, ou \2C (hexadécimal).
                if (i + 2 < dn.Length && Uri.IsHexDigit(dn[i + 1]) && Uri.IsHexDigit(dn[i + 2]))
                {
                    value.Append((char)Convert.ToInt32(dn.Substring(i + 1, 2), 16));
                    i += 2;
                }
                else
                {
                    value.Append(dn[++i]);
                }
                continue;
            }
            value.Append(c);
        }
        return value.ToString().Trim();
    }

    /// <summary>
    /// Serveurs de la configuration, dans l'ordre : « hôte » ou « hôte:port » séparés par des virgules ou des espaces ; une
    /// adresse collée (ldaps://dc1.contoso.local:636) est acceptée. null si l'un d'eux n'est pas un nom d'hôte valide.
    /// </summary>
    public static List<(string Host, int Port)>? Servers(string? hosts, int defaultPort)
    {
        var servers = new List<(string Host, int Port)>();
        foreach (var raw in (hosts ?? "").Split([',', ';', ' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries))
        {
            var item = raw.Trim();
            var scheme = item.IndexOf("://", StringComparison.Ordinal);
            if (scheme >= 0) item = item[(scheme + 3)..];
            item = item.TrimEnd('/');
            var port = defaultPort;
            var colon = item.LastIndexOf(':');
            if (colon > 0)
            {
                if (!int.TryParse(item[(colon + 1)..], out port) || port is < 1 or > 65535) return null;
                item = item[..colon];
            }
            if (!HostName().IsMatch(item)) return null;
            servers.Add((item, port));
        }
        return servers;
    }

    // ------------------------------------------------------------ connexion, liaison, recherche

    private static CancellationTokenSource Deadline(CancellationToken ct)
    {
        var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(OperationTimeout * 3);
        return deadline;
    }

    /// <summary>Connexion au premier serveur qui répond (TLS selon les réglages, délai de 10 s par serveur).</summary>
    private static async Task<LdapConnection> ConnectAsync(LdapSettings s, CancellationToken ct)
    {
        LdapException? last = null;
        foreach (var (host, port) in Servers(s.Hosts, s.Port) ?? [])
        {
            var options = new LdapConnectionOptions();
            if (s.Security == LdapSettings.Ldaps) options.UseSsl();
            if (s.IgnoreCertificateErrors) options.ConfigureRemoteCertificateValidationCallback((_, _, _, _) => true);
            else if (s.Security != LdapSettings.Clear && LdapTrust.Load(s.CaCertificate) is { } authorities)
                options.ConfigureRemoteCertificateValidationCallback((_, certificate, chain, errors) => LdapTrust.Accepts(certificate, chain, errors, authorities));
            var connection = new LdapConnection(options) { ConnectionTimeout = (int)OperationTimeout.TotalMilliseconds };
            try
            {
                await connection.ConnectAsync(host, port, ct);
                if (s.Security == LdapSettings.StartTls) await connection.StartTlsAsync(ct);
                return connection;
            }
            catch (LdapException ex)
            {
                connection.Dispose();
                last = ex;
            }
            catch (Exception ex) when (ex is SocketException or IOException or AuthenticationException)
            {
                connection.Dispose();
                last = new LdapException(ex.Message, LdapException.ConnectError, null, ex);
            }
            catch
            {
                connection.Dispose();
                throw;
            }
        }
        throw last ?? new LdapException("Aucun serveur d'annuaire configuré.", LdapException.ConnectError, null);
    }

    /// <summary>Liaison : null si acceptée, l'erreur si les identifiants sont refusés ; toute autre erreur remonte.</summary>
    private static async Task<LdapException?> TryBindAsync(LdapConnection connection, string name, string password, CancellationToken ct)
    {
        try
        {
            await connection.BindAsync(name, password, new LdapConstraints { TimeLimit = (int)OperationTimeout.TotalMilliseconds }, ct);
            return null;
        }
        catch (LdapException ex) when (ex.ResultCode is LdapException.InvalidCredentials or LdapException.InappropriateAuthentication)
        {
            return ex;
        }
    }

    private static async Task<(LdapEntry? Entry, Outcome? Problem)> FindAsync(LdapConnection connection, LdapSettings s, string lookup, CancellationToken ct)
    {
        var filter = s.UserFilter.Replace("{0}", EscapeFilterValue(lookup), StringComparison.Ordinal);
        var found = await SearchAsync(connection, s.BaseDn!.Trim(), LdapConnection.ScopeSub, filter, AccountAttributes(s), 2, ct);
        return found.Count switch
        {
            0 => (null, null),
            1 => (found[0], null),
            _ => (null, new Outcome(null, Misconfigured, $"plusieurs comptes correspondent à « {lookup} » : précisez le filtre de recherche")),
        };
    }

    private static async Task<List<LdapEntry>> SearchAsync(LdapConnection connection, string baseDn, int scope, string filter, string[] attributes, int limit, CancellationToken ct)
    {
        var constraints = new LdapSearchConstraints
        {
            TimeLimit = (int)OperationTimeout.TotalMilliseconds,
            ServerTimeLimit = (int)OperationTimeout.TotalSeconds,
            MaxResults = limit,
            ReferralFollowing = false,
        };
        var results = await connection.SearchAsync(baseDn, scope, filter, attributes, false, constraints, ct);
        var entries = new List<LdapEntry>();
        try
        {
            while (await results.HasMoreAsync(ct))
            {
                try
                {
                    entries.Add(await results.NextAsync(ct));
                }
                catch (LdapReferralException)
                {
                    // Active Directory signale d'autres partitions (DomainDnsZones…) depuis la racine du domaine : ignorées.
                }
            }
        }
        catch (LdapException ex) when (ex.ResultCode == LdapException.SizeLimitExceeded)
        {
            // Au-delà de la limite demandée : les premiers résultats suffisent (un compte ambigu est ainsi détecté).
        }
        return entries;
    }

    /// <summary>Groupes du compte : ceux de l'attribut (memberOf), et ceux trouvés par recherche (imbriqués pour Active Directory).</summary>
    private async Task<List<string>> GroupsAsync(LdapConnection connection, LdapSettings s, LdapEntry entry, CancellationToken ct)
    {
        var groups = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (Values(entry, s.GroupAttribute) is { } direct) groups.UnionWith(direct);
        var member = EscapeFilterValue(entry.Dn);
        var filter = !s.IsActiveDirectory() ? $"(|(member={member})(uniqueMember={member}))"
            : s.NestedGroups ? $"(member:{InChainRule}:={member})"
            : null;
        if (filter is null) return [.. groups];
        try
        {
            foreach (var group in await SearchAsync(connection, s.BaseDn!.Trim(), LdapConnection.ScopeSub, filter, ["cn"], 1000, ct)) groups.Add(group.Dn);
        }
        catch (LdapException ex) when (ex.ResultCode is not (LdapException.ConnectError or LdapException.ServerDown))
        {
            // Recherche refusée (droits) : les groupes directs suffisent.
            log.LogWarning("Annuaire : groupes de {Dn} non recherchés ({Error}), groupes directs seulement.", entry.Dn, Describe(ex));
        }
        return [.. groups];
    }

    // ------------------------------------------------------------ identifiants et comptes

    /// <summary>Identifiant cherché : CONTOSO\jdupont → jdupont (Active Directory) ; sinon tel quel.</summary>
    private static string LookupName(LdapSettings s, string login)
    {
        var slash = login.IndexOf('\\');
        return s.IsActiveDirectory() && slash > 0 ? login[(slash + 1)..] : login;
    }

    /// <summary>Active Directory sans compte de service : UPN ou DOMAINE\compte tels quels, sinon identifiant + suffixe UPN.</summary>
    private static string BindName(LdapSettings s, string login) =>
        login.Contains('@') || login.Contains('\\') || string.IsNullOrWhiteSpace(s.UpnSuffix) ? login : $"{login}@{s.UpnSuffix.Trim().TrimStart('@')}";

    private static string[] AccountAttributes(LdapSettings s) =>
        [.. new[] { s.UsernameAttribute, s.DisplayNameAttribute, s.MailAttribute, s.GroupAttribute, "userAccountControl", "userPrincipalName", "sAMAccountName", "uid", "cn" }
            .Where(a => !string.IsNullOrWhiteSpace(a)).Distinct(StringComparer.OrdinalIgnoreCase)];

    /// <summary>Active Directory : bit ACCOUNTDISABLE (2) de userAccountControl.</summary>
    private static bool IsDisabled(LdapSettings s, LdapEntry entry) =>
        s.IsActiveDirectory() && long.TryParse(First(entry, "userAccountControl"), out var flags) && (flags & 2) != 0;

    private static Account ToAccount(LdapSettings s, LdapEntry entry, string lookup, IEnumerable<string> groups)
    {
        var username = First(entry, s.UsernameAttribute)
                       ?? (s.IsActiveDirectory() ? First(entry, "userPrincipalName") ?? First(entry, "sAMAccountName") : First(entry, "uid"))
                       ?? lookup;
        return new(entry.Dn, username, First(entry, s.DisplayNameAttribute) ?? First(entry, "cn"), First(entry, s.MailAttribute), [.. groups]);
    }

    private static string[]? Values(LdapEntry entry, string attribute) =>
        entry.GetAttributeSet().TryGetValue(attribute, out var values) ? values.StringValueArray : null;

    private static string? First(LdapEntry entry, string attribute) =>
        Values(entry, attribute) is [var first, ..] && !string.IsNullOrWhiteSpace(first) ? first.Trim() : null;

    /// <summary>Domaine DNS d'un DN, par ses composants DC (CN=…,OU=…,DC=contoso,DC=local → contoso.local).</summary>
    private static string DnsDomain(string dn) => string.Join('.', dn.Split(',')
        .Select(part => part.Trim())
        .Where(part => part.StartsWith("DC=", StringComparison.OrdinalIgnoreCase))
        .Select(part => part[3..]));

    private static string ServerName(LdapEntry root)
    {
        var kind = First(root, "vendorName") is { } vendor ? $"{vendor} {First(root, "vendorVersion")}".Trim()
            : Values(root, "supportedCapabilities")?.Contains(ActiveDirectoryCapability) == true ? "Active Directory"
            : "Annuaire LDAP";
        return First(root, "dnsHostName") is { } host ? $"{kind} ({host})" : kind;
    }

    // ------------------------------------------------------------ erreurs

    /// <summary>Liaison refusée : sous-code d'Active Directory (« data 52e ») traduit, sans rien révéler à la personne.</summary>
    private static Outcome Refused(LdapException ex, string who)
    {
        var code = AdSubCode().Match(ex.LdapErrorMessage ?? "") is { Success: true } match ? match.Groups[1].Value.ToLowerInvariant() : null;
        return code switch
        {
            "773" or "532" => new(null, PasswordChange, $"{who} : mot de passe expiré ou à changer (AD {code})"),
            "775" => new(null, Locked, $"{who} : compte verrouillé (AD 775)"),
            "533" => new(null, Credentials, $"{who} : compte désactivé dans l'annuaire (AD 533)"),
            "701" => new(null, Credentials, $"{who} : compte expiré dans l'annuaire (AD 701)"),
            "530" or "531" => new(null, Credentials, $"{who} : connexion interdite à cette heure ou depuis ce poste (AD {code})"),
            _ => new(null, Credentials, $"{who} : identifiant ou mot de passe refusé"),
        };
    }

    private static Outcome Fault(LdapException ex)
    {
        var detail = Describe(ex);
        return ex.ResultCode switch
        {
            LdapException.SslHandshakeFailed or LdapException.TlsNotSupported => new(null, Unavailable, $"négociation TLS impossible : {detail}"),
            LdapException.ConnectError or LdapException.ServerDown when IsTls(ex) =>
                new(null, Unavailable, $"négociation TLS impossible (certificat non approuvé, ou nom du serveur différent de celui du certificat) : {detail}"),
            LdapException.ConnectError or LdapException.ServerDown or LdapException.Unavailable or LdapException.Busy =>
                new(null, Unavailable, $"annuaire injoignable : {detail}"),
            LdapException.LdapTimeout or LdapException.TimeLimitExceeded => new(null, Unavailable, "l'annuaire n'a pas répondu à temps"),
            LdapException.StrongAuthRequired or LdapException.ConfidentialityRequired =>
                new(null, Misconfigured, "l'annuaire exige une connexion chiffrée : choisissez LDAPS (636) ou StartTLS"),
            LdapException.NoSuchObject => new(null, Misconfigured, $"DN de base introuvable dans l'annuaire : {detail}"),
            LdapException.FilterError => new(null, Misconfigured, "filtre de recherche invalide"),
            LdapException.OperationsError when detail.Contains("000004DC", StringComparison.Ordinal) =>
                new(null, Misconfigured, "l'annuaire refuse la recherche anonyme : renseignez un compte de service"),
            LdapException.InsufficientAccessRights => new(null, Misconfigured, $"droits insuffisants pour chercher les comptes : {detail}"),
            _ => new(null, Unavailable, $"erreur LDAP {ex.ResultCode} ({ex.ResultCodeToString()}) : {detail}"),
        };
    }

    private static bool IsTls(Exception ex)
    {
        for (var e = ex.InnerException; e is not null; e = e.InnerException)
            if (e is AuthenticationException) return true;
        return false;
    }

    /// <summary>Message du serveur (diagnostic LDAP), sinon de la cause réseau : jamais de mot de passe.</summary>
    private static string Describe(LdapException ex)
    {
        if (!string.IsNullOrWhiteSpace(ex.LdapErrorMessage)) return ex.LdapErrorMessage.Trim();
        var cause = ex.InnerException;
        while (cause?.InnerException is not null) cause = cause.InnerException;
        return (cause?.Message ?? ex.Message).Trim();
    }

    /// <summary>Erreur d'une étape du test de connexion, en phrase.</summary>
    private static string Explain(Exception ex)
    {
        var detail = ex is LdapException ldap ? Fault(ldap).Detail! : "l'annuaire n'a pas répondu à temps";
        return char.ToUpperInvariant(detail[0]) + detail[1..] + ".";
    }
}
