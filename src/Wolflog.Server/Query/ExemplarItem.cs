namespace Wolflog.Server.Query;

public sealed record ExemplarItem(DateTime Ts, double Value, string TraceId, string? SpanId, string Service, string Attributes);
