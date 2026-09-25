namespace Wolflog.Server.Query;

public sealed record ServiceInfo(string Name, long Logs, long Errors, long Spans, long SpanErrors, double? P95Ms, DateTime? LastSeen);
