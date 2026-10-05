namespace Wolflog.Server.Query;

/// <summary>Activité récente d'un visiteur : anonyme, ou utilisateur connecté désigné par le début de son pseudonyme.</summary>
public sealed record AnalyticsLiveEvent(DateTime Ts, byte Kind, string Service, string Path, string? EventName, string? Referrer,
    string? Country, string? Browser, string? Os, string? Device, string Visitor, string? User);
