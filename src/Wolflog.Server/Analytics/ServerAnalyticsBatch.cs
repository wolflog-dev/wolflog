namespace Wolflog.Server.Analytics;

/// <summary>Lot d'événements d'audience envoyé côté serveur sur /v1/analytics.</summary>
public sealed class ServerAnalyticsBatch
{
    public string? Service { get; set; }
    public string? Env { get; set; }
    public List<ServerAnalyticsEvent> Events { get; set; } = [];
}
