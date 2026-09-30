namespace Wolflog.Server.Query;

/// <summary>Ligne d'une ventilation (page, référent, pays…) : visiteurs distincts et nombre (vues, clics, occurrences).</summary>
public sealed record AnalyticsBreakdownRow(string? Value, long Visitors, long Count);
