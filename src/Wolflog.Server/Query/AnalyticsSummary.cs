namespace Wolflog.Server.Query;

/// <summary>Indicateurs d'audience d'une période.</summary>
public sealed record AnalyticsSummary(long Visitors, long Visits, long Pageviews, long Events, long Bounces, double TotalSeconds, double Revenue)
{
    public double BounceRate => Visits > 0 ? Bounces * 100.0 / Visits : 0;
    public double AvgVisitSeconds => Visits > 0 ? TotalSeconds / Visits : 0;
}
