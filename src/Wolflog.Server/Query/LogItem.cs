namespace Wolflog.Server.Query;

public sealed record LogItem(
    DateTime Ts, string Service, string? Host, string? Env, string? Version, byte Severity, string Level,
    string Body, string? TraceId, string? SpanId, string? Category, string? ExceptionType, string? ExceptionMessage,
    string? ExceptionStack, string? Fingerprint, bool IsCrash, string Attributes, string Resource);
