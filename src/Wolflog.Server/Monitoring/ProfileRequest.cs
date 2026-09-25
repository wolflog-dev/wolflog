namespace Wolflog.Server.Monitoring;

public sealed record ProfileRequest(string Id, string Service, string Instance, string Kind, int Seconds, DateTime RequestedAt, string? RequestedBy);
