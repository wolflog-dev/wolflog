namespace Wolflog.DemoDirectory;

/// <summary>
/// Entreprise fictive Contoso : domaine contoso.local (CONTOSO), groupes Wolflog dont un imbriqué, six personnes (dont un
/// compte désactivé et un mot de passe à changer) et un compte de service en lecture. Mots de passe : README.md du dossier.
/// </summary>
public static class ContosoDirectory
{
    public const string BaseDn = "DC=contoso,DC=local";
    public const string NetbiosName = "CONTOSO";
    public const string DnsName = "contoso.local";
    public const string UsersOu = "OU=Utilisateurs," + BaseDn;
    public const string GroupsOu = "OU=Groupes," + BaseDn;
    public const string ServiceDn = "CN=svc-wolflog,OU=Comptes de service," + BaseDn;
    public const string ServicePassword = "Lecture-Annuaire-2026";

    /// <summary>Groupes : les quatre de Wolflog, et « Equipe-Web », membre de Wolflog-Produit (groupe imbriqué).</summary>
    public static readonly IReadOnlyList<(string Name, string Description)> Groups =
    [
        ("Wolflog-Admins", "Administrateurs de Wolflog"),
        ("Wolflog-Dev", "Développeurs : tout voir, modifier"),
        ("Wolflog-Produit", "Équipe produit : audience, clics et défilement"),
        ("Wolflog-Exploitation", "Exploitation : logs, métriques, alertes"),
        ("Equipe-Web", "Équipe web, membre de Wolflog-Produit"),
    ];

    public static readonly IReadOnlyList<DemoAccount> Accounts =
    [
        new("jdupont", "Jeanne Dupont", "Dupont-2026!", ["Wolflog-Admins"]),
        new("pmartin", "Paul Martin", "Martin-2026!", ["Wolflog-Dev"]),
        new("sbernard", "Sophie Bernard", "Bernard-2026!", ["Equipe-Web"]),
        new("lpetit", "Luc Petit", "Petit-2026!", ["Wolflog-Exploitation"]),
        new("lmoreau", "Léa Moreau", "Moreau-2026!", ["Wolflog-Dev"], MustChangePassword: true),
        new("mdurand", "Marc Durand", "Durand-2026!", ["Wolflog-Dev"], Disabled: true),
    ];

    public static string GroupDn(string name) => $"CN={name},{GroupsOu}";

    public static string UserDn(DemoAccount account) => $"CN={account.Name},{UsersOu}";

    public static InMemoryDirectory Create()
    {
        var directory = new InMemoryDirectory(BaseDn, NetbiosName, DnsName);
        directory.Add(BaseDn).Set("objectClass", "top", "domain", "domainDNS").Set("dc", "contoso").Set("name", "contoso");
        foreach (var unit in new[] { "Utilisateurs", "Groupes", "Comptes de service" })
            directory.Add($"OU={unit},{BaseDn}").Set("objectClass", "top", "organizationalUnit").Set("ou", unit).Set("name", unit);

        foreach (var (name, description) in Groups)
            directory.Add(GroupDn(name))
                .Set("objectClass", "top", "group")
                .Set("objectCategory", $"CN=Group,CN=Schema,CN=Configuration,{BaseDn}")
                .Set("cn", name).Set("name", name).Set("sAMAccountName", name).Set("description", description);
        directory.AddMember(GroupDn("Wolflog-Produit"), GroupDn("Equipe-Web"));

        foreach (var account in Accounts)
        {
            var names = account.Name.Split(' ', 2);
            var entry = Person(directory, UserDn(account), account.Login, account.Name)
                .Set("givenName", names[0]).Set("sn", names[^1])
                .Set("mail", $"{account.Login}@contoso.fr")
                // 512 : compte normal ; 514 : désactivé (bit ACCOUNTDISABLE). pwdLastSet = 0 : mot de passe à changer.
                .Set("userAccountControl", account.Disabled ? "514" : "512")
                .Set("pwdLastSet", account.MustChangePassword ? "0" : "134050176000000000");
            entry.Password = account.Password;
            foreach (var group in account.Groups) directory.AddMember(GroupDn(group), entry.Dn);
        }

        var service = Person(directory, ServiceDn, "svc-wolflog", "svc-wolflog")
            .Set("description", "Compte de service de Wolflog : lecture de l'annuaire")
            .Set("userAccountControl", "66048");
        service.Password = ServicePassword;
        return directory;
    }

    private static DirectoryEntry Person(InMemoryDirectory directory, string dn, string login, string name) => directory.Add(dn)
        .Set("objectClass", "top", "person", "organizationalPerson", "user")
        .Set("objectCategory", $"CN=Person,CN=Schema,CN=Configuration,{BaseDn}")
        .Set("cn", name).Set("name", name).Set("displayName", name)
        .Set("sAMAccountName", login).Set("userPrincipalName", $"{login}@{DnsName}");
}
