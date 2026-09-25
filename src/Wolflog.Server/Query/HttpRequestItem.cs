namespace Wolflog.Server.Query;

public sealed record HttpRequestItem(
    DateTime Ts, string TraceId, string SpanId, string Service, string Method, string? Route, string Target,
    int? Status, double DurationMs, bool Error, bool HasBody);
