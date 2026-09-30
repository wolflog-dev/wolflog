namespace Wolflog.Server.Query;

/// <summary>Valeur d'une propriété envoyée avec un événement (ex. plan = pro).</summary>
public sealed record AnalyticsEventProperty(string Key, string? Value, long Count);
