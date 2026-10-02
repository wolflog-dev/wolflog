namespace Wolflog.Server.Security;

/// <summary>
/// Parties de Wolflog qu'un profil d'accès rend visibles (mêmes identifiants que l'interface, core/access.ts).
/// Les pages d'administration restent réservées au rôle administrateur ; « Mon compte » est toujours accessible.
/// </summary>
public static class AccessSections
{
    public const string Overview = "overview";
    public const string Dashboards = "dashboards";
    public const string Logs = "logs";
    public const string Requests = "requests";
    public const string Traces = "traces";
    public const string Errors = "errors";
    public const string Metrics = "metrics";
    public const string Map = "map";
    public const string Profiles = "profiles";
    public const string Audience = "audience";
    public const string Clickmaps = "clickmaps";
    public const string Alerts = "alerts";
    public const string Uptime = "uptime";
    public const string Slos = "slos";

    /// <summary>Toutes les parties, dans l'ordre de la navigation.</summary>
    public static readonly IReadOnlyList<string> All =
        [Overview, Dashboards, Logs, Requests, Traces, Errors, Metrics, Map, Profiles, Audience, Clickmaps, Alerts, Uptime, Slos];

    public static bool IsValid(string? id) => id is not null && All.Contains(id);

    /// <summary>Parties dans l'ordre de la navigation, sans doublon ni identifiant inconnu.</summary>
    public static List<string> Normalize(IEnumerable<string>? ids)
    {
        var set = ids?.ToHashSet(StringComparer.Ordinal) ?? [];
        return All.Where(set.Contains).ToList();
    }

    /// <summary>Nom d'une partie, tel qu'affiché dans la navigation (messages d'erreur).</summary>
    public static string Label(string id) => id switch
    {
        Overview => "Vue d'ensemble",
        Dashboards => "Tableaux de bord",
        Logs => "Logs",
        Requests => "Requêtes HTTP",
        Traces => "Traces",
        Errors => "Erreurs",
        Metrics => "Métriques",
        Map => "Carte des services",
        Profiles => "Profils (CPU, mémoire)",
        Audience => "Audience",
        Clickmaps => "Clics et défilement",
        Alerts => "Alertes",
        Uptime => "Disponibilité",
        Slos => "Objectifs (SLO)",
        _ => id,
    };
}
