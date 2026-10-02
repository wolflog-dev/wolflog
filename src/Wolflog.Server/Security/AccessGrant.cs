namespace Wolflog.Server.Security;

/// <summary>
/// Accès effectif d'un compte : profil appliqué, parties visibles (dans l'ordre de la navigation), page d'accueil
/// et services visibles. <see cref="Everything"/> : toutes les parties (administrateur, compte sans profil ou « Tout voir »,
/// authentification désactivée) ; les services peuvent rester limités (<see cref="Services"/>).
/// </summary>
public sealed record AccessGrant(AccessProfile? Profile, bool Everything, IReadOnlyList<string> Sections, string? Home)
{
    /// <summary>Tout voir, sans profil (administrateur, authentification désactivée).</summary>
    public static readonly AccessGrant Full = new(null, true, AccessSections.All, AccessSections.Overview);

    /// <summary>Services visibles (tous par défaut) : ceux du profil, ou la liste propre au compte.</summary>
    public ServiceScope Services { get; init; } = ServiceScope.All;

    /// <summary>Aucune limite : toutes les parties et tous les services.</summary>
    public bool Unrestricted => Everything && Services.IsAll;

    public bool Allows(string section) => Everything || Sections.Contains(section);
}
