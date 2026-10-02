namespace Wolflog.Server.Security;

/// <summary>
/// Profil d'accès : les parties de Wolflog qu'une personne peut voir (son rôle dit ce qu'elle peut y faire).
/// Sans effet sur les administrateurs, qui voient tout.
/// </summary>
public sealed class AccessProfile : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    /// <summary>Icône de l'interface (core/icons.ts).</summary>
    public string? Icon { get; set; }
    /// <summary>Parties visibles (<see cref="AccessSections"/>), dans l'ordre de la navigation. Ignoré pour « Tout voir ».</summary>
    public List<string> Sections { get; set; } = [];
    /// <summary>Page d'accueil : la partie ouverte en arrivant sur Wolflog (l'une des parties visibles).</summary>
    public string? Home { get; set; }
    /// <summary>Services visibles : noms ou motifs avec * (« boutique-* ») ; vide : tous. Ignoré pour « Tout voir ».</summary>
    public List<string> Services { get; set; } = [];
    /// <summary>Profil fourni par Wolflog : modifiable, jamais supprimé.</summary>
    public bool Builtin => AccessProfileStore.IsBuiltin(Id);
}
