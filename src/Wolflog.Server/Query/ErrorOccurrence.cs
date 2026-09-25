namespace Wolflog.Server.Query;

public sealed record ErrorOccurrence(DateTime Ts, string Service, string? Host, string? Version, string? TraceId, bool IsCrash, string? Message);
