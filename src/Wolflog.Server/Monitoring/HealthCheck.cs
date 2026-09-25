namespace Wolflog.Server.Monitoring;

/// <summary>ok, warning ou critical.</summary>
public sealed record HealthCheck(string Id, string Name, string Status, string Message, double? Value = null);
