namespace Wolflog.Server.Query;

/// <summary>
/// Environnement vu sur les 7 derniers jours, avec son activité (sélecteur d'environnement de l'interface) : environnement
/// configuré, qui regroupe des valeurs reçues (voir <see cref="EnvironmentFilter"/>), ou valeur reçue telle quelle.
/// Name est la valeur de ?env= ; Services, le nombre d'applications qui y ont envoyé des données.
/// </summary>
public sealed record EnvironmentInfo(string Name, long Logs, long Errors, long Spans, int Services, DateTime? LastSeen)
{
    /// <summary>Libellé affiché (la valeur reçue elle-même si l'environnement n'est pas configuré).</summary>
    public string Label { get; init; } = Name;
    /// <summary>production, recette, developpement ou autre (deviné d'après le nom s'il n'est pas configuré).</summary>
    public string Kind { get; init; } = EnvironmentKinds.Other;
    /// <summary>Teinte de l'interface : danger, warn, ok ou accent.</summary>
    public string Tone { get; init; } = EnvironmentKinds.Tone(null);
    /// <summary>Couleur personnalisée (#rrggbb), prioritaire sur la teinte ; null : celle de la teinte.</summary>
    public string? Color { get; init; }
    /// <summary>Position dans le sélecteur : environnements configurés dans leur ordre, puis valeurs reçues par ordre alphabétique.</summary>
    public int Order { get; init; }
    /// <summary>Environnement configuré (Administration › Environnements) ; false : valeur reçue telle quelle.</summary>
    public bool Configured { get; init; }
    /// <summary>Valeurs reçues regroupées sous cet environnement.</summary>
    public IReadOnlyList<string> Raw { get; init; } = [];
    /// <summary>Applications qui y ont envoyé des données, et les valeurs reçues de chacune.</summary>
    public IReadOnlyList<EnvironmentApp> Apps { get; init; } = [];
}
