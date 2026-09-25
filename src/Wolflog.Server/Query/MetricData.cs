namespace Wolflog.Server.Query;

public sealed record MetricData(string Name, string Stat, string? Unit, int StepSeconds, IReadOnlyList<DateTime> Times, IReadOnlyList<MetricSeries> Series);
