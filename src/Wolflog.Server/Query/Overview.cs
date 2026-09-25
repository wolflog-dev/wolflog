namespace Wolflog.Server.Query;

public sealed record Overview(
    long Logs, long Errors, long Crashes, long Spans, long Traces, double? P95Ms,
    Histogram LogHistogram, IReadOnlyList<ServiceInfo> Services, IReadOnlyList<ErrorGroup> TopErrors);
