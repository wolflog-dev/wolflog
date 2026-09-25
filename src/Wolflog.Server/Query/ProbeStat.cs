namespace Wolflog.Server.Query;

public sealed record ProbeStat(string ProbeId, long Checks, double? Uptime, double? AvgMs, double? P95Ms, IReadOnlyList<double?> Buckets);
