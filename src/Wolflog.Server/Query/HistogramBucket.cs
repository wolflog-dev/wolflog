namespace Wolflog.Server.Query;

public sealed record HistogramBucket(DateTime T, long Trace, long Debug, long Info, long Warn, long Error, long Fatal);
