namespace Wolflog.Server.Api;

/// <summary>
/// Ce qu'une personne peut voir des tableaux de bord : le tableau (« Visible pour »), puis ses panneaux (parties et services
/// de son profil d'accès). Un tableau ne lui est proposé que s'il en reste au moins un panneau utilisable.
/// </summary>
/// <param name="user">Compte connecté ; null : authentification désactivée (tout est visible).</param>
/// <param name="grant">Parties et services visibles du compte.</param>
public sealed class DashboardAccess(User? user, AccessGrant grant)
{
    public static DashboardAccess For(HttpContext ctx, AuthService auth, AccessProfileStore profiles) =>
        auth.Enabled && ctx.User.UserId() is { } uid && auth.Users.Get(uid) is { } user
            ? new DashboardAccess(user, profiles.GrantFor(user))
            : new DashboardAccess(null, AccessGrant.Full);

    /// <summary>Administrateur, ou authentification désactivée : tous les tableaux, tous les panneaux.</summary>
    public bool Admin => user is null || user.Role == Roles.Admin;

    /// <summary>Profil d'accès du compte tel que le désigne « Visible pour » (sans profil : « Tout voir »).</summary>
    public string ProfileId => string.IsNullOrEmpty(user?.ProfileId) ? AccessProfileStore.Everything : user.ProfileId;

    public bool Visible(Dashboard d) => Admin || d.VisibleTo.Count == 0 || d.VisibleTo.Contains(ProfileId);

    /// <summary>Panneau dont les données sont ouvertes à la personne : partie de son profil et, s'il est fixé, service visible.</summary>
    public bool Panel(Panel p) =>
        Admin || grant.Unrestricted
        || (Sections(p).Any(grant.Allows)
            && (string.IsNullOrWhiteSpace(p.Service) || p.Service.Contains('$') || grant.Services.Allows(p.Service)));

    /// <summary>Tableau proposé : visible, et au moins un panneau utilisable (un tableau vide reste proposé).</summary>
    public bool CanUse(Dashboard d) => Visible(d) && (d.Panels.Count == 0 || d.Panels.Any(Panel));

    /// <summary>Raison du refus d'un tableau, en clair.</summary>
    public string Refusal(Dashboard d) => !Visible(d)
        ? "Ce tableau de bord n'est pas visible avec votre profil d'accès."
        : "Aucun panneau de ce tableau de bord n'entre dans votre profil d'accès.";

    /// <summary>Tableau tel que la personne le voit : copie sans les panneaux hors de son profil, avec leur nombre.</summary>
    public Dashboard View(Dashboard d)
    {
        var copy = JsonSerializer.Deserialize<Dashboard>(JsonSerializer.Serialize(d, Json), Json)!;
        var hidden = copy.Panels.RemoveAll(p => !Panel(p));
        copy.HiddenPanels = hidden > 0 ? hidden : null;
        return copy;
    }

    /// <summary>
    /// Panneaux enregistrés par une personne qui ne les voit pas tous : ceux qu'elle ne voit pas gardent leur place,
    /// les siens (dans son nouvel ordre) occupent les autres places, ses nouveaux panneaux s'ajoutent à la fin.
    /// </summary>
    public List<Panel> Merge(IReadOnlyList<Panel> existing, IReadOnlyList<Panel> submitted)
    {
        if (Admin) return [.. submitted];
        var hidden = existing.Where(p => !Panel(p)).Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        // Un panneau caché ne peut être ni modifié ni remplacé par quelqu'un qui ne le voit pas.
        var mine = new Queue<Panel>(submitted.Where(p => !hidden.Contains(p.Id)));
        var result = new List<Panel>(existing.Count + mine.Count);
        foreach (var p in existing)
        {
            if (hidden.Contains(p.Id)) result.Add(p);
            else if (mine.Count > 0) result.Add(mine.Dequeue());
        }
        result.AddRange(mine);
        return result;
    }

    /// <summary>
    /// « Visible pour » nettoyé ; message d'erreur si un profil n'existe pas, ou si une personne limitée retirerait son propre
    /// profil (le tableau disparaîtrait pour elle). Un profil supprimé depuis (déjà dans <paramref name="existing"/>) est
    /// simplement retiré, sans bloquer l'enregistrement.
    /// </summary>
    public string? NormalizeVisibility(Dashboard d, AccessProfileStore profiles, Dashboard? existing = null)
    {
        var stale = existing?.VisibleTo ?? [];
        d.VisibleTo = (d.VisibleTo ?? []).Select(id => (id ?? "").Trim()).Where(id => id.Length > 0).Distinct(StringComparer.Ordinal)
            .Where(id => profiles.Get(id) is not null || !stale.Contains(id)).ToList();
        if (d.VisibleTo.FirstOrDefault(id => profiles.Get(id) is null) is { } unknown) return $"Profil d'accès inconnu : « {unknown} ».";
        if (!Admin && d.VisibleTo.Count > 0 && !d.VisibleTo.Contains(ProfileId))
            return $"Gardez votre profil (« {profiles.Get(ProfileId)?.Name ?? ProfileId} ») dans « Visible pour » : sinon ce tableau disparaîtrait pour vous.";
        return null;
    }

    /// <summary>Parties de Wolflog dont un panneau lit les données (l'une suffit) : même règle que l'interface (panelSections).</summary>
    public static string[] Sections(Panel p) => p.Type switch
    {
        "custom" => ApiSections.BySource(p.DataSource) ?? [AccessSections.Logs],
        "http" => [AccessSections.Requests],
        "metric" => [AccessSections.Metrics],
        "logs" or "logs-table" => [AccessSections.Logs],
        "errors" => [AccessSections.Errors],
        _ => p.Source switch { "logs" => [AccessSections.Logs], "errors" => [AccessSections.Errors], _ => [AccessSections.Requests] },
    };

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
}
