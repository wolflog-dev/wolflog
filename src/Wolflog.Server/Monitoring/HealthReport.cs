namespace Wolflog.Server.Monitoring;

public sealed record HealthReport(string Status, IReadOnlyList<HealthCheck> Checks, DateTime At);
