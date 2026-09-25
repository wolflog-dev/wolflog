namespace Wolflog.Server.Query;

public sealed record TraceSummary(
    string TraceId, DateTime Start, double DurationMs, int Spans, string RootName, string RootService,
    int Services, int Errors);
