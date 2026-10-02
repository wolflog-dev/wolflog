namespace Wolflog.Server.Configuration;

/// <summary>
/// Environnement configuré : son nom (valeur de ?env=, des alertes et des liens) regroupe les valeurs envoyées par les
/// applications. Le nom en fait toujours partie ; les alias s'y ajoutent, sans tenir compte de la casse.
/// </summary>
public sealed class EnvironmentDefinition
{
    /// <summary>Identifiant stable, en minuscules (ex. production).</summary>
    public string Name { get; set; } = "";
    /// <summary>Libellé affiché (ex. Production).</summary>
    public string Label { get; set; } = "";
    /// <summary>production, recette, developpement ou autre : donne la couleur (voir <see cref="EnvironmentKinds"/>).</summary>
    public string Kind { get; set; } = EnvironmentKinds.Other;
    /// <summary>Couleur personnalisée (#rrggbb), prioritaire sur celle du type ; null : celle du type.</summary>
    public string? Color { get; set; }
    /// <summary>Position dans le sélecteur (croissante).</summary>
    public int Order { get; set; }
    /// <summary>Absent du sélecteur de la barre du haut ; ses données restent accessibles (lien, alerte, recherche).</summary>
    public bool Hidden { get; set; }
    /// <summary>Valeurs envoyées par les applications regroupées sous ce nom (ex. prod, prd).</summary>
    public List<string> Aliases { get; set; } = [];
}
