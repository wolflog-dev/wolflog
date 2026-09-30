namespace Wolflog.Server.Query;

/// <summary>Indicateurs de la période et de la période précédente de même durée.</summary>
public sealed record AnalyticsComparison(AnalyticsSummary Current, AnalyticsSummary Previous);
