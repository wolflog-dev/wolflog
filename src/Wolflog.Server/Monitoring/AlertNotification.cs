namespace Wolflog.Server.Monitoring;

public sealed record AlertNotification(
    string Status, string RuleName, string Severity, string Message, string? Link, string? Runbook, DateTime At);
