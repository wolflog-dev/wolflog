namespace Wolflog.Server.Configuration;

/// <summary>
/// Réglages propres à une application (nom du service) : ses alias, qui priment pour elle seule sur ceux des environnements
/// (deux applications peuvent donner le même nom à des environnements différents), et les environnements masqués de son sélecteur.
/// </summary>
public sealed class AppEnvironments
{
    public string Service { get; set; } = "";
    /// <summary>Valeur envoyée par l'application → nom de l'environnement ; "" : valeur gardée telle quelle (non regroupée).</summary>
    public Dictionary<string, string> Aliases { get; set; } = [];
    /// <summary>Environnements (noms, ou valeurs non regroupées) absents du sélecteur quand cette application est choisie.</summary>
    public List<string> Hidden { get; set; } = [];
}
