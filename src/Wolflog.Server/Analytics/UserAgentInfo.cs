using System.Text.RegularExpressions;

namespace Wolflog.Server.Analytics;

/// <summary>Catégories grossières tirées du User-Agent (le User-Agent lui-même n'est pas stocké).</summary>
public sealed partial record UserAgentInfo(string? Browser, string? Os, string Device, bool IsBot)
{
    [GeneratedRegex(@"bot|crawl|spider|slurp|scrap|facebookexternalhit|preview|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl|wget|python|java/|go-http|axios|node-fetch|okhttp|phantom|selenium|puppeteer|playwright", RegexOptions.IgnoreCase)]
    private static partial Regex BotPattern();

    [GeneratedRegex("iPad|Tablet|Kindle|Silk|PlayBook", RegexOptions.IgnoreCase)]
    private static partial Regex TabletPattern();

    [GeneratedRegex("Mobi|iPhone|iPod|Windows Phone", RegexOptions.IgnoreCase)]
    private static partial Regex MobilePattern();

    public static UserAgentInfo Parse(string? ua, int? viewportWidth = null)
    {
        ua ??= "";
        if (ua.Length < 16 || BotPattern().IsMatch(ua)) return new UserAgentInfo(null, null, "desktop", true);
        var browser =
            ua.Contains("Edg", StringComparison.Ordinal) ? "Edge"
            : ua.Contains("OPR/", StringComparison.Ordinal) ? "Opera"
            : ua.Contains("SamsungBrowser", StringComparison.Ordinal) ? "Samsung Internet"
            : ua.Contains("Firefox/", StringComparison.Ordinal) || ua.Contains("FxiOS", StringComparison.Ordinal) ? "Firefox"
            : ua.Contains("Chrome/", StringComparison.Ordinal) || ua.Contains("CriOS", StringComparison.Ordinal) ? "Chrome"
            : ua.Contains("Safari/", StringComparison.Ordinal) ? "Safari"
            : "Autre";
        var os =
            ua.Contains("iPhone", StringComparison.Ordinal) || ua.Contains("iPod", StringComparison.Ordinal) ? "iOS"
            : ua.Contains("iPad", StringComparison.Ordinal) ? "iPadOS"
            : ua.Contains("Android", StringComparison.Ordinal) ? "Android"
            : ua.Contains("CrOS", StringComparison.Ordinal) ? "Chrome OS"
            : ua.Contains("Windows", StringComparison.Ordinal) ? "Windows"
            : ua.Contains("Mac OS X", StringComparison.Ordinal) || ua.Contains("Macintosh", StringComparison.Ordinal) ? "macOS"
            : ua.Contains("Linux", StringComparison.Ordinal) ? "Linux"
            : "Autre";
        var device =
            TabletPattern().IsMatch(ua) || (ua.Contains("Android", StringComparison.Ordinal) && !ua.Contains("Mobile", StringComparison.Ordinal)) ? "tablet"
            : MobilePattern().IsMatch(ua) ? "mobile"
            : viewportWidth is > 0 and < 600 ? "mobile"
            : viewportWidth is > 0 and < 1024 ? "tablet"
            : "desktop";
        return new UserAgentInfo(browser, os, device, false);
    }
}
