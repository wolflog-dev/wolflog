namespace Wolflog.Server.Configuration;

public static class ErrorStatus
{
    public const string Open = "open";
    public const string Resolved = "resolved";
    public const string Ignored = "ignored";
    public const string Regressed = "regressed";

    /// <summary>Statut affiché : une erreur résolue qui se reproduit après sa résolution est "réapparue".</summary>
    public static string Effective(ErrorState? state, DateTime lastSeen) => state?.Status switch
    {
        Resolved when state.ResolvedAt is { } at && lastSeen > at => Regressed,
        Resolved => Resolved,
        Ignored => Ignored,
        _ => Open,
    };
}
