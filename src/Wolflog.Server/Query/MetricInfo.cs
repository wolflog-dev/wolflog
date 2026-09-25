namespace Wolflog.Server.Query;

public sealed record MetricInfo(string Name, byte Type, string? Unit, string? Description, long Points);
