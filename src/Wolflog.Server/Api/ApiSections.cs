namespace Wolflog.Server.Api;

/// <summary>
/// Partie de Wolflog dont relève chaque route de /api, pour les profils d'accès (filtre posé par <see cref="AccessEndpoints"/>).
/// Une route absente d'ici est refusée aux profils restreints : toute nouvelle route doit y être rattachée
/// (vérifié par AccessProfileTests). /api/auth et /api/grafana (clé de lecture) ne passent pas par ce contrôle.
/// </summary>
public static class ApiSections
{
    private static readonly string[] Shared = [];

    /// <summary>
    /// Parties qui ouvrent une route (une seule suffit) ; vide : route commune à toutes les parties ; null : route inconnue.
    /// </summary>
    /// <param name="route">Gabarit de la route, ex. <c>/api/traces/{traceId}</c>.</param>
    /// <param name="method">Méthode HTTP (la liste des sondes et des objectifs sert aussi aux alertes).</param>
    /// <param name="query">Paramètres de la requête (source d'une requête personnalisée).</param>
    public static string[]? For(string route, string method, IQueryCollection query)
    {
        var segments = route.ToLowerInvariant().Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length < 2 || segments[0] != "api") return null;
        var single = segments.Length == 2;
        var list = single && HttpMethods.IsGet(method);
        return segments[1] switch
        {
            // Communes : filtres de la barre du haut, équipe, déploiements, recherches enregistrées, mon compte, habillage.
            "services" or "environments" or "people" or "deployments" or "searches" or "account" or "branding" => Shared,
            // Administration : réservée au rôle administrateur (qui voit tout), sans partie propre.
            "admin" or "sources" or "notification-settings" => Shared,
            "system" => single ? [AccessSections.Overview] : Shared,
            "overview" or "health" => [AccessSections.Overview],
            "dashboards" => [AccessSections.Dashboards],
            "logs" => [AccessSections.Logs],
            "requests" => [AccessSections.Requests],
            // Le détail d'une trace est aussi celui d'une requête HTTP (panneau de la page Requêtes HTTP).
            "traces" => single ? [AccessSections.Traces] : [AccessSections.Traces, AccessSections.Requests],
            "errors" => [AccessSections.Errors],
            "metrics" => [AccessSections.Metrics],
            "service-map" => [AccessSections.Map],
            "profiles" or "profiling" => [AccessSections.Profiles],
            "analytics" => segments.Length > 2 && segments[2] is "clickmaps" or "clickmap" or "frustrations"
                ? [AccessSections.Clickmaps] : [AccessSections.Audience],
            "alerts" or "alert-channels" => [AccessSections.Alerts],
            // Listes des sondes et des objectifs : aussi pour choisir la cible d'une alerte (ou d'un objectif).
            "probes" => list ? [AccessSections.Uptime, AccessSections.Alerts, AccessSections.Slos] : [AccessSections.Uptime],
            "slos" => list ? [AccessSections.Slos, AccessSections.Alerts] : [AccessSections.Slos],
            // Requête personnalisée et valeurs d'un champ : selon la source interrogée ; noms des champs : communs.
            "query" => BySource(query["source"].ToString()),
            "fields" => single ? Shared : BySource(query["source"].ToString()),
            _ => null,
        };
    }

    /// <summary>
    /// Partie d'une source de requête personnalisée (aussi celle d'un panneau de tableau de bord), normalisée comme le fait
    /// le moteur (source inconnue = logs).
    /// </summary>
    public static string[]? BySource(string? source) => QueryService.NormalizeSource(source) switch
    {
        "logs" => [AccessSections.Logs],
        "spans" => [AccessSections.Traces, AccessSections.Requests],
        "metrics" => [AccessSections.Metrics],
        "analytics" => [AccessSections.Audience],
        _ => null,
    };
}
