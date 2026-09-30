namespace Wolflog.Server.Query;

/// <summary>Visiteurs et pages vues par tranche de temps (série complète, tranches vides incluses).</summary>
public sealed record AnalyticsSeries(int Step, List<DateTime> Times, List<long> Visitors, List<long> Pageviews, List<long>? PreviousVisitors);
