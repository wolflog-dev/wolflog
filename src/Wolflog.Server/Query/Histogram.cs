namespace Wolflog.Server.Query;

public sealed record Histogram(int StepSeconds, IReadOnlyList<HistogramBucket> Buckets);
