namespace Wolflog.Server.Query;

public sealed record TraceDetail(string TraceId, IReadOnlyList<SpanItem> Spans, IReadOnlyList<LogItem> Logs);
