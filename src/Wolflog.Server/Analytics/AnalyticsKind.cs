namespace Wolflog.Server.Analytics;

/// <summary>Nature d'une ligne d'audience (colonne <c>kind</c>).</summary>
public static class AnalyticsKind
{
    public const byte Pageview = 1;
    public const byte Event = 2;
    public const byte Click = 3;
    public const byte Scroll = 4;
}
