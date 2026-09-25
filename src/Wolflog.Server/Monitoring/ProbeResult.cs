namespace Wolflog.Server.Monitoring;

public sealed record ProbeResult(DateTime At, bool Ok, double DurationMs, int? Status, string? Error, int? CertificateDays);
