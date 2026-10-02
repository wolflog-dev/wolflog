namespace Wolflog.Server.Security;

/// <summary>
/// Profils d'accès (&lt;data&gt;/access-profiles.json). Profils fournis, ajoutés au démarrage s'ils manquent :
/// « Tout voir » (all, celui des comptes sans profil), « Produit » (product) et « Exploitation » (ops).
/// Lus à chaque requête (collection en mémoire) : une modification s'applique aussitôt.
/// </summary>
public sealed class AccessProfileStore : JsonCollection<AccessProfile>
{
    /// <summary>« Tout voir » : toutes les parties, y compris celles des versions à venir ; profil des comptes sans profil.</summary>
    public const string Everything = "all";
    public const string Product = "product";
    public const string Ops = "ops";

    public AccessProfileStore(IOptions<WolflogServerOptions> options, IHostEnvironment env)
        : base(options.Value.ResolveDataDirectory(env.ContentRootPath), "access-profiles.json")
    {
        foreach (var profile in Builtins())
            if (Get(profile.Id) is null) Upsert(profile);
    }

    public static bool IsBuiltin(string? id) => id is Everything or Product or Ops;

    /// <summary>Parties visibles d'un profil (« Tout voir » : toutes, même celles ajoutées après sa création).</summary>
    public static IReadOnlyList<string> SectionsOf(AccessProfile profile) =>
        profile.Id == Everything ? AccessSections.All : AccessSections.Normalize(profile.Sections);

    /// <summary>Page d'accueil : celle du profil si elle est visible, sinon la première partie visible.</summary>
    public static string? HomeOf(AccessProfile profile)
    {
        var sections = SectionsOf(profile);
        return profile.Home is { } home && sections.Contains(home) ? home : sections.FirstOrDefault();
    }

    /// <summary>
    /// Compte sans aucune limite : administrateur, ou compte sans profil (« Tout voir ») sans liste de services propre
    /// (aucune lecture de profil nécessaire).
    /// </summary>
    public static bool SeesEverything(User user) =>
        user.Role == Roles.Admin
        || ((string.IsNullOrEmpty(user.ProfileId) || user.ProfileId == Everything) && (user.Services is null || ServiceScope.Normalize(user.Services).Count == 0));

    /// <summary>Services visibles d'un profil (« Tout voir » : tous).</summary>
    public static IReadOnlyList<string> ServicesOf(AccessProfile profile) =>
        profile.Id == Everything ? [] : ServiceScope.Normalize(profile.Services);

    /// <summary>
    /// Ce que voit un compte : tout pour un administrateur ; sinon les parties de son profil (« Tout voir » sans profil)
    /// et les services de son profil, ou sa propre liste de services quand il en a une.
    /// </summary>
    public AccessGrant GrantFor(User user)
    {
        if (user.Role == Roles.Admin) return AccessGrant.Full;
        var id = string.IsNullOrEmpty(user.ProfileId) ? Everything : user.ProfileId;
        var profile = Get(id);
        AccessGrant grant;
        if (id == Everything) grant = AccessGrant.Full with { Profile = profile ?? Builtins()[0] };
        // Profil inconnu (configuration modifiée à la main) : rien plutôt que tout.
        else if (profile is null) return new AccessGrant(new AccessProfile { Id = id, Name = "Profil introuvable" }, false, [], null);
        else grant = new AccessGrant(profile, false, SectionsOf(profile), HomeOf(profile));
        var services = user.Services is { } own ? ServiceScope.Normalize(own) : ServicesOf(grant.Profile!);
        return services.Count == 0 ? grant : grant with { Services = new ServiceScope(services) };
    }

    /// <summary>Profil à attribuer à un compte : vide ou « all » → null (tout voir) ; false si ce profil n'existe pas.</summary>
    public bool TryResolve(string requested, out string? profileId)
    {
        profileId = string.IsNullOrWhiteSpace(requested) || requested.Trim() == Everything ? null : requested.Trim();
        return profileId is null || Get(profileId) is not null;
    }

    private static List<AccessProfile> Builtins() =>
    [
        new()
        {
            Id = Everything, Name = "Tout voir", Icon = "code", Home = AccessSections.Overview, Sections = [.. AccessSections.All],
            Description = "Développeurs : toutes les parties de Wolflog, y compris celles des prochaines versions. Profil des comptes sans profil.",
        },
        new()
        {
            Id = Product, Name = "Produit", Icon = "compass", Home = AccessSections.Audience,
            Sections = [AccessSections.Dashboards, AccessSections.Audience, AccessSections.Clickmaps],
            Description = "Product owners : visiteurs, parcours, cartes de chaleur et tableaux de bord.",
        },
        new()
        {
            Id = Ops, Name = "Exploitation", Icon = "server", Home = AccessSections.Overview,
            Sections = [AccessSections.Overview, AccessSections.Logs, AccessSections.Metrics, AccessSections.Alerts, AccessSections.Uptime, AccessSections.Slos],
            Description = "Administrateurs système : vue d'ensemble, logs, métriques, disponibilité, alertes et objectifs de service.",
        },
    ];
}
