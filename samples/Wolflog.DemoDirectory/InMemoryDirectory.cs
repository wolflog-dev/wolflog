namespace Wolflog.DemoDirectory;

/// <summary>
/// Annuaire en mémoire qui se comporte comme Active Directory là où Wolflog en dépend : liaison par DN, UPN ou
/// DOMAINE\compte, erreurs « data 52e / 533 / 773 / 775 », groupes imbriqués (LDAP_MATCHING_RULE_IN_CHAIN), opérateurs
/// binaires sur userAccountControl, catégorie d'objet écrite en DN ou en nom court.
/// </summary>
public sealed class InMemoryDirectory
{
    public const string InChainRule = "1.2.840.113556.1.4.1941";
    public const string BitAndRule = "1.2.840.113556.1.4.803";
    public const string BitOrRule = "1.2.840.113556.1.4.804";

    /// <summary>Attributs dont les valeurs sont des DN : comparés une fois normalisés.</summary>
    private static readonly HashSet<string> DnAttributes = new(StringComparer.OrdinalIgnoreCase) { "distinguishedName", "member", "memberOf", "manager" };

    private readonly Dictionary<string, DirectoryEntry> _entries = new(StringComparer.Ordinal);
    private readonly List<DirectoryEntry> _ordered = [];

    public InMemoryDirectory(string rootDn, string netbiosName, string dnsName)
    {
        RootDn = rootDn;
        NetbiosName = netbiosName;
        DnsName = dnsName;
        // Entrée racine (RootDSE) : lisible sans liaison, elle donne notamment le DN de base (defaultNamingContext).
        RootDse = new DirectoryEntry("")
            .Set("objectClass", "top")
            .Set("namingContexts", rootDn)
            .Set("defaultNamingContext", rootDn)
            .Set("rootDomainNamingContext", rootDn)
            .Set("configurationNamingContext", $"CN=Configuration,{rootDn}")
            .Set("schemaNamingContext", $"CN=Schema,CN=Configuration,{rootDn}")
            .Set("dnsHostName", $"dc01.{dnsName}")
            .Set("supportedLDAPVersion", "3", "2")
            // LDAP_CAP_ACTIVE_DIRECTORY_OID : se présente comme un contrôleur Active Directory.
            .Set("supportedCapabilities", "1.2.840.113556.1.4.800")
            .Set("vendorName", "Wolflog DemoDirectory");
    }

    public string RootDn { get; }

    public string NetbiosName { get; }

    public string DnsName { get; }

    public DirectoryEntry RootDse { get; }

    public IReadOnlyList<DirectoryEntry> Entries => _ordered;

    public DirectoryEntry Add(string dn)
    {
        var entry = new DirectoryEntry(dn).Set("distinguishedName", dn);
        _entries[Normalize(dn)] = entry;
        _ordered.Add(entry);
        return entry;
    }

    /// <summary>Appartenance à un groupe : member côté groupe, memberOf côté membre (comme Active Directory le calcule).</summary>
    public void AddMember(string groupDn, string memberDn)
    {
        (Find(groupDn) ?? throw new ArgumentException($"Groupe inconnu : {groupDn}")).Append("member", memberDn);
        (Find(memberDn) ?? throw new ArgumentException($"Membre inconnu : {memberDn}")).Append("memberOf", groupDn);
    }

    public DirectoryEntry? Find(string dn) => _entries.GetValueOrDefault(Normalize(dn));

    /// <summary>
    /// Liaison simple comme Active Directory : nom = DN, UPN ou DOMAINE\compte. Erreurs « data » d'AD : 52e (identifiants
    /// refusés, compte inconnu compris), 775 (verrouillé), 533 (désactivé), 773 (mot de passe à changer).
    /// </summary>
    public (DirectoryEntry? Account, string? Data) Authenticate(string name, string password)
    {
        var account = FindAccount(name);
        if (account?.Password is null) return (null, "52e");
        if (account.First("lockoutTime") is { } locked && locked != "0") return (null, "775");
        if (!string.Equals(account.Password, password, StringComparison.Ordinal)) return (null, "52e");
        if ((Flags(account) & 2) != 0) return (null, "533");
        if (account.First("pwdLastSet") == "0") return (null, "773");
        return (account, null);
    }

    /// <summary>Compte désigné par un DN, un UPN ou DOMAINE\compte (sAMAccountName).</summary>
    public DirectoryEntry? FindAccount(string name)
    {
        if (name.Contains('=')) return Find(name);
        var slash = name.IndexOf('\\');
        if (slash > 0)
        {
            if (!string.Equals(name[..slash], NetbiosName, StringComparison.OrdinalIgnoreCase)) return null;
            var account = name[(slash + 1)..];
            return _ordered.FirstOrDefault(e => string.Equals(e.First("sAMAccountName"), account, StringComparison.OrdinalIgnoreCase));
        }
        return _ordered.FirstOrDefault(e => string.Equals(e.First("userPrincipalName"), name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Entrées couvertes par une recherche : l'entrée de base, ses enfants directs, ou tout le sous-arbre.</summary>
    public IEnumerable<DirectoryEntry> InScope(DirectoryEntry baseEntry, SearchScope scope)
    {
        var baseKey = Normalize(baseEntry.Dn);
        foreach (var entry in _ordered)
        {
            var key = Normalize(entry.Dn);
            var under = key.EndsWith("," + baseKey, StringComparison.Ordinal);
            var include = scope switch
            {
                SearchScope.BaseObject => key == baseKey,
                SearchScope.SingleLevel => under && !key[..^(baseKey.Length + 1)].Contains(','),
                _ => key == baseKey || under,
            };
            if (include) yield return entry;
        }
    }

    /// <summary>DN existant le plus proche d'un DN introuvable (matchedDN de l'erreur « noSuchObject »).</summary>
    public string MatchedDn(string dn)
    {
        var parts = dn.Split(',');
        for (var i = 1; i < parts.Length; i++)
        {
            var parent = string.Join(',', parts[i..]);
            if (Find(parent) is { } found) return found.Dn;
        }
        return "";
    }

    /// <summary>Égalité : sans tenir compte de la casse ; DN normalisés ; catégorie d'objet en DN ou en nom court (« person »).</summary>
    public bool Equal(DirectoryEntry entry, string attribute, string value)
    {
        if (string.Equals(attribute, "objectCategory", StringComparison.OrdinalIgnoreCase))
            return entry.Values(attribute).Any(v => SameDn(v, value) || string.Equals(CommonName(v), value, StringComparison.OrdinalIgnoreCase));
        if (DnAttributes.Contains(attribute)) return entry.Values(attribute).Any(v => SameDn(v, value));
        return entry.Values(attribute).Any(v => string.Equals(v, value, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Règle de correspondance étendue : groupes imbriqués, ET / OU binaires ; sans règle, simple égalité.</summary>
    public bool MatchesRule(DirectoryEntry entry, string? rule, string? attribute, string value)
    {
        switch (rule)
        {
            case InChainRule when string.Equals(attribute, "memberOf", StringComparison.OrdinalIgnoreCase):
                return IsMemberOf(entry, value);
            case InChainRule when string.Equals(attribute, "member", StringComparison.OrdinalIgnoreCase):
                return HasMember(entry, value);
            case BitAndRule or BitOrRule when attribute is not null && long.TryParse(value, out var mask):
                return entry.Values(attribute).Any(v => long.TryParse(v, out var flags) && (rule == BitAndRule ? (flags & mask) == mask : (flags & mask) != 0));
            case null when attribute is not null:
                return Equal(entry, attribute, value);
            default:
                return false;
        }
    }

    /// <summary>Membre du groupe, directement ou par un groupe lui-même membre (memberOf, de proche en proche).</summary>
    public bool IsMemberOf(DirectoryEntry entry, string groupDn) => Reaches(entry, "memberOf", groupDn);

    /// <summary>Le groupe contient ce membre, directement ou par un groupe membre (member, de proche en proche).</summary>
    public bool HasMember(DirectoryEntry group, string memberDn) => Reaches(group, "member", memberDn);

    private bool Reaches(DirectoryEntry start, string link, string targetDn)
    {
        var target = Normalize(targetDn);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Queue<string>(start.Values(link));
        while (pending.TryDequeue(out var dn))
        {
            var key = Normalize(dn);
            if (key == target) return true;
            if (!seen.Add(key)) continue;
            if (Find(dn) is { } next) foreach (var further in next.Values(link)) pending.Enqueue(further);
        }
        return false;
    }

    /// <summary>DN comparable : minuscules, sans espaces autour des séparateurs.</summary>
    public static string Normalize(string dn) => string.Join(',', dn.Split(',').Select(rdn =>
    {
        var equal = rdn.IndexOf('=');
        return equal < 0 ? rdn.Trim().ToLowerInvariant() : rdn[..equal].Trim().ToLowerInvariant() + "=" + rdn[(equal + 1)..].Trim().ToLowerInvariant();
    }));

    public static bool SameDn(string a, string b) => Normalize(a) == Normalize(b);

    /// <summary>Valeur du premier élément d'un DN : « Wolflog-Admins » pour CN=Wolflog-Admins,OU=Groupes,….</summary>
    public static string CommonName(string dn)
    {
        var first = dn.Split(',')[0];
        var equal = first.IndexOf('=');
        return equal < 0 ? first.Trim() : first[(equal + 1)..].Trim();
    }

    private static long Flags(DirectoryEntry entry) => long.TryParse(entry.First("userAccountControl"), out var flags) ? flags : 0;
}
