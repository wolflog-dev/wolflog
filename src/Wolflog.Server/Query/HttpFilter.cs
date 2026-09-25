namespace Wolflog.Server.Query;

public sealed record HttpFilter(string? Service, string? Text, string? StatusClass, double? MinDurationMs, bool Outgoing);
