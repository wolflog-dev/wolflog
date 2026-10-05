namespace Wolflog.Server.Analytics;

/// <summary>
/// Événement envoyé par une application (Wolflog.Client.Blazor, API) avec une clé serveur.
/// L'IP et le User-Agent du visiteur servent uniquement à calculer l'empreinte anonyme, puis sont oubliés.
/// </summary>
public sealed class ServerAnalyticsEvent
{
    /// <summary>pageview ou event.</summary>
    public string Type { get; set; } = "pageview";
    public long Ts { get; set; }
    /// <summary>Chemin, éventuellement avec la query string (seuls les paramètres UTM sont conservés).</summary>
    public string? Path { get; set; }
    public string? Title { get; set; }
    public string? Referrer { get; set; }
    public string? Hostname { get; set; }
    public string? Name { get; set; }
    public JsonElement? Data { get; set; }
    public string? Ip { get; set; }
    public string? UserAgent { get; set; }
    public string? Language { get; set; }
    /// <summary>Utilisateur connecté (identifiant de l'application) : remplacé aussitôt par un pseudonyme, jamais stocké.</summary>
    public string? User { get; set; }
}
