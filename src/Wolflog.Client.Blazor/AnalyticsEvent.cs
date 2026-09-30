namespace Wolflog.Client.Blazor;

/// <summary>Événement envoyé à /v1/analytics (format de ServerAnalyticsEvent côté serveur).</summary>
internal sealed record AnalyticsEvent(
    string Type, long Ts, string Path, string? Title, string? Referrer, string? Hostname, string? Name, object? Data,
    string? Ip, string? UserAgent, string? Language);
