namespace Wolflog.Server.Query;

/// <summary>Visiteurs, utilisateurs identifiés et pages vues par tranche de temps (série complète, tranches vides incluses).</summary>
public sealed record AnalyticsSeries(int Step, List<DateTime> Times, List<long> Visitors, List<long> Users, List<long> Pageviews, List<long>? PreviousVisitors);
