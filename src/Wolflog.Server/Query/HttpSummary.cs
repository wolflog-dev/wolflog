namespace Wolflog.Server.Query;

public sealed record HttpSummary(long Count, double RatePerSecond, long Errors, double ErrorRate, double? P50Ms, double? P95Ms, double? P99Ms);
