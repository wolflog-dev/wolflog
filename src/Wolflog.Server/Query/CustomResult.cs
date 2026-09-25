namespace Wolflog.Server.Query;

public sealed record CustomResult(
    string View, string? Unit, int StepSeconds,
    IReadOnlyList<DateTime>? Times, IReadOnlyList<MetricSeries>? Series,
    IReadOnlyList<CustomRow>? Rows, double? Value, long Count);
