namespace Wolflog.Server.Security;

/// <summary>
/// Compte Wolflog créé ou mis à jour à chaque connexion par l'annuaire (Microsoft Entra ID, OpenID Connect, Windows,
/// LDAP / Active Directory) : domaines autorisés, rôle et profil d'accès par défaut, correspondances de groupes, comptes
/// désactivés refusés.
/// </summary>
public static class SsoProvisioning
{
    // Raisons de refus, reprises par la page de connexion (/login?sso=…).
    public const string Disabled = "disabled";
    public const string Domain = "domain";
    public const string Conflict = "conflict";
    public const string NoIdentity = "identity";

    /// <summary>Deux connexions simultanées du même nouveau compte ne doivent pas en créer deux.</summary>
    private static readonly Lock Gate = new();

    /// <summary>Règles de création et de mise à jour des comptes.</summary>
    /// <param name="DefaultRole">Rôle d'un nouveau compte qu'aucun groupe ne désigne.</param>
    /// <param name="DefaultProfileId">Profil d'accès d'un nouveau compte qu'aucun groupe ne désigne (null = tout voir).</param>
    /// <param name="AllowedDomains">Domaines acceptés (vide = tous) ; sans objet pour l'annuaire LDAP, qui choisit ses comptes par le DN de base et le filtre.</param>
    /// <param name="Groups">Correspondances de groupes.</param>
    /// <param name="FollowDirectory">
    /// true : dès qu'une correspondance donne un rôle (ou un profil), il est recalculé à chaque connexion : celui du groupe
    /// trouvé, sinon celui par défaut ; quitter le groupe retire donc les droits. false (section Oidc de wolflog.json) :
    /// un groupe trouvé l'emporte, sans groupe le compte garde son rôle.
    /// </param>
    public sealed record Rules(string DefaultRole, string? DefaultProfileId, IReadOnlyList<string> AllowedDomains,
        IReadOnlyList<SsoGroupMapping> Groups, bool FollowDirectory);

    /// <summary>Compte connecté, ou raison du refus.</summary>
    public sealed record Result(User? User, string? Refusal);

    /// <summary>Ce que donnerait la connexion : refus éventuel, nouveau compte ou non, rôle et profil d'accès.</summary>
    public sealed record Decision(string? Refusal, bool IsNew, string Role, string? ProfileId);

    public static Result Provision(UserStore users, DirectoryIdentity identity, Rules rules)
    {
        lock (Gate)
        {
            var user = users.ByUsername(identity.Username);
            var decision = Decide(users, user, identity, rules);
            if (decision.Refusal is not null) return new(null, decision.Refusal);
            user ??= new User
            {
                Username = identity.Username,
                Source = identity.Method == "ldap" ? "ldap" : "sso",
                DisplayName = identity.AccountName,
            };
            user.Role = decision.Role;
            user.ProfileId = decision.ProfileId;
            if (identity.DisplayName is not null) user.DisplayName = identity.DisplayName;
            if (identity.Email is not null) user.Email = identity.Email;
            user.LastLoginAt = DateTime.UtcNow;
            return new(users.Upsert(user), null);
        }
    }

    /// <summary>Résultat d'une connexion, sans rien enregistrer (Administration > Connexion SSO > Tester un compte).</summary>
    public static Decision Preview(UserStore users, DirectoryIdentity identity, Rules rules) =>
        Decide(users, users.ByUsername(identity.Username), identity, rules);

    private static Decision Decide(UserStore users, User? user, DirectoryIdentity identity, Rules rules)
    {
        var matched = rules.Groups.Where(m => identity.Groups.Contains(m.Group.Trim())).ToList();
        var groupRole = matched.Select(m => m.Role).Where(Roles.IsValid).MaxBy(Rank);
        var groupProfile = matched.Select(m => m.ProfileId).FirstOrDefault(p => !string.IsNullOrWhiteSpace(p));
        var defaultRole = Roles.IsValid(rules.DefaultRole) ? rules.DefaultRole : Roles.Viewer;
        var defaultProfile = string.IsNullOrWhiteSpace(rules.DefaultProfileId) ? null : rules.DefaultProfileId;

        if (identity.Method != "ldap" && !DomainAllowed(identity.Username, rules.AllowedDomains)) return new(Domain, user is null, defaultRole, defaultProfile);
        if (user is null) return new(null, true, groupRole ?? defaultRole, groupProfile ?? defaultProfile);

        // Compte local du même nom : jamais pris par l'annuaire LDAP, qui passe par le même formulaire (le compte local garde son
        // seul mot de passe Wolflog). Microsoft ou Windows : rattaché s'il porte un identifiant d'annuaire (UPN, DOMAINE\nom), jamais « admin ».
        if (user.Source is not ("sso" or "ldap") && (identity.Method == "ldap" || !IsDirectoryName(user.Username)))
            return new(Conflict, false, user.Role, user.ProfileId);
        if (user.Disabled) return new(Disabled, false, user.Role, user.ProfileId);
        var role = groupRole ?? (rules.FollowDirectory && rules.Groups.Any(m => Roles.IsValid(m.Role)) ? defaultRole : user.Role);
        // Jamais de rétrogradation du dernier administrateur actif : il doit pouvoir corriger les correspondances.
        if (user.Role == Roles.Admin && role != Roles.Admin && users.All().Count(u => u.Role == Roles.Admin && !u.Disabled) <= 1) role = Roles.Admin;
        var profile = groupProfile ?? (rules.FollowDirectory && rules.Groups.Any(m => !string.IsNullOrWhiteSpace(m.ProfileId)) ? defaultProfile : user.ProfileId);
        return new(null, false, role, profile);
    }

    /// <summary>Raison d'un refus, pour l'administrateur (dernier échec, journaux).</summary>
    public static string Explain(string? refusal) => refusal switch
    {
        Disabled => "compte désactivé dans Wolflog",
        Domain => "domaine non autorisé",
        Conflict => "un compte local porte déjà ce nom",
        NoIdentity => "l'annuaire n'a transmis aucun identifiant",
        _ => "connexion refusée",
    };

    private static int Rank(string? role) => role switch { Roles.Admin => 3, Roles.Editor => 2, _ => 1 };

    private static bool IsDirectoryName(string username) => username.Contains('@') || username.Contains('\\');

    /// <summary>Domaine de l'identifiant (après @ pour un UPN, avant \ pour un compte Windows) parmi ceux autorisés.</summary>
    private static bool DomainAllowed(string username, IReadOnlyList<string> allowed)
    {
        if (allowed.Count == 0) return true;
        var at = username.LastIndexOf('@');
        var slash = username.IndexOf('\\');
        var domain = at > 0 ? username[(at + 1)..] : slash > 0 ? username[..slash] : null;
        return domain is not null && allowed.Any(d => string.Equals(d, domain, StringComparison.OrdinalIgnoreCase));
    }
}
