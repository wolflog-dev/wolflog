namespace Wolflog.Server.Query;

public sealed record ErrorGroup(
    string Fingerprint, string ExceptionType, string? Message, string Service, long Count, long Crashes,
    DateTime FirstSeen, DateTime LastSeen, int Services)
{
    /// <summary>open, regressed, resolved, ignored (voir ErrorStatus).</summary>
    public string Status { get; init; } = "open";
    public string? AssignedTo { get; init; }
}
