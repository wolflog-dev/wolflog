namespace Wolflog.Server.Query;

public sealed record SpanItem(
    DateTime Ts, double DurationMs, string TraceId, string SpanId, string? ParentSpanId, string Service, string? Host,
    string Name, byte Kind, byte StatusCode, string? StatusMessage, string? Scope, string Attributes, string Events, string Resource);
