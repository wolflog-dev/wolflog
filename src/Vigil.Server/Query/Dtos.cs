namespace Vigil.Server.Query;

public sealed record LogItem(
    DateTime Ts, string Service, string? Host, string? Env, string? Version, byte Severity, string Level,
    string Body, string? TraceId, string? SpanId, string? Category, string? ExceptionType, string? ExceptionMessage,
    string? ExceptionStack, string? Fingerprint, bool IsCrash, string Attributes, string Resource);

public sealed record LogPage(IReadOnlyList<LogItem> Items, DateTime? NextBefore, long ElapsedMs, int ScannedSegments, int TotalSegments);

public sealed record HistogramBucket(DateTime T, long Trace, long Debug, long Info, long Warn, long Error, long Fatal);

public sealed record Histogram(int StepSeconds, IReadOnlyList<HistogramBucket> Buckets);

public sealed record TraceSummary(
    string TraceId, DateTime Start, double DurationMs, int Spans, string RootName, string RootService,
    int Services, int Errors);

public sealed record SpanItem(
    DateTime Ts, double DurationMs, string TraceId, string SpanId, string? ParentSpanId, string Service, string? Host,
    string Name, byte Kind, byte StatusCode, string? StatusMessage, string? Scope, string Attributes, string Events, string Resource);

public sealed record TraceDetail(string TraceId, IReadOnlyList<SpanItem> Spans, IReadOnlyList<LogItem> Logs);

public sealed record ErrorGroup(
    string Fingerprint, string ExceptionType, string? Message, string Service, long Count, long Crashes,
    DateTime FirstSeen, DateTime LastSeen, int Services);

public sealed record ErrorOccurrence(DateTime Ts, string Service, string? Host, string? Version, string? TraceId, bool IsCrash, string? Message);

public sealed record ErrorDetail(ErrorGroup Group, LogItem? Latest, IReadOnlyList<ErrorOccurrence> Occurrences, Histogram Histogram);

public sealed record MetricInfo(string Name, byte Type, string? Unit, string? Description, long Points);

public sealed record MetricSeries(string Name, string Group, IReadOnlyList<double?> Values);

public sealed record MetricData(string Name, string Stat, string? Unit, int StepSeconds, IReadOnlyList<DateTime> Times, IReadOnlyList<MetricSeries> Series);

public sealed record ServiceInfo(string Name, long Logs, long Errors, long Spans, long SpanErrors, double? P95Ms, DateTime? LastSeen);

public sealed record Overview(
    long Logs, long Errors, long Crashes, long Spans, long Traces, double? P95Ms,
    Histogram LogHistogram, IReadOnlyList<ServiceInfo> Services, IReadOnlyList<ErrorGroup> TopErrors);

public sealed record StoreStats(string Name, long IngestedRows, long HotRows, int Segments, long DiskBytes, DateTime? Oldest);

public sealed record SystemStats(DateTime StartedAt, string DataDirectory, long DiskBytes, long MemoryBytes, int LiveTailClients, IReadOnlyList<StoreStats> Stores, string Version);
