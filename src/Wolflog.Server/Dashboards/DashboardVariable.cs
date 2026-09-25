namespace Wolflog.Server.Dashboards;

/// <summary>
/// Variable de tableau de bord : une liste de valeurs (ex. les routes) choisie dans l'en-tête,
/// réutilisée dans les panneaux par $nom (filtre, service, regroupement, titre).
/// </summary>
public sealed class DashboardVariable
{
    public string Name { get; set; } = "";
    public string? Label { get; set; }
    /// <summary>Champ dont on propose les valeurs (service, env, host, http.route, attribut…).</summary>
    public string Field { get; set; } = "service";
    /// <summary>logs, spans ou metrics : où chercher les valeurs.</summary>
    public string Source { get; set; } = "spans";
    public string? Default { get; set; }
}
