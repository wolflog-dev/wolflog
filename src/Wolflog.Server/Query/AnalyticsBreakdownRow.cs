namespace Wolflog.Server.Query;

/// <summary>Ligne d'une ventilation (page, référent, pays…) : visiteurs et utilisateurs distincts, nombre (vues, clics, occurrences).</summary>
public sealed record AnalyticsBreakdownRow(string? Value, long Visitors, long Count, long Users);
