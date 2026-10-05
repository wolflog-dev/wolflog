namespace Wolflog.Server.Query;

/// <summary>Temps réel : visiteurs et utilisateurs connectés actifs (5 min), activité et top des 30 dernières minutes.</summary>
public sealed record AnalyticsRealtime(long Active, long Visitors, long ActiveUsers, long Users, List<long> PerMinute, List<AnalyticsLiveEvent> Recent,
    List<AnalyticsBreakdownRow> Pages, List<AnalyticsBreakdownRow> Referrers, List<AnalyticsBreakdownRow> Countries);
