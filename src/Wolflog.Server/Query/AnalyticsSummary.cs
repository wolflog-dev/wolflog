namespace Wolflog.Server.Query;

/// <summary>
/// Indicateurs d'audience d'une période. Utilisateurs : personnes identifiées par l'application (pseudonymes distincts),
/// dont les nouveaux, vus pour la première fois sur la période.
/// </summary>
public sealed record AnalyticsSummary(long Visitors, long Visits, long Pageviews, long Events, long Bounces, double TotalSeconds, double Revenue,
    long Users, long NewUsers)
{
    public double BounceRate => Visits > 0 ? Bounces * 100.0 / Visits : 0;
    public double AvgVisitSeconds => Visits > 0 ? TotalSeconds / Visits : 0;
}
