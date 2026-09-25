namespace Wolflog.Server.Query;

public sealed record MetricSeries(string Name, string Group, IReadOnlyList<double?> Values);
