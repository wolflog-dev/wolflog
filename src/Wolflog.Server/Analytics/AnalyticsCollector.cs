using System.Text.RegularExpressions;

namespace Wolflog.Server.Analytics;

/// <summary>
/// Transforme les mesures reçues (script RUM ou application) en lignes d'audience anonymes :
/// empreinte de visiteur (ou pseudonyme de l'utilisateur connecté), référent réduit au domaine,
/// paramètres d'URL supprimés (sauf UTM), catégories de navigateur.
/// </summary>
public sealed partial class AnalyticsCollector(StorageHost storage, VisitorIdentity identity)
{
    private static readonly string[] CountryHeaders = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code", "x-appengine-country"];

    [GeneratedRegex(@"^[a-z]{2,3}[-_]([a-z]{2})\b", RegexOptions.IgnoreCase)]
    private static partial Regex LanguageRegion();

    /// <summary>Lignes d'audience issues d'un lot du script navigateur (pages, événements, clics, défilement).</summary>
    public List<AnalyticsRow> FromBrowser(RumEndpoints.RumBatch batch, string service, HttpContext ctx)
    {
        var rows = new List<AnalyticsRow>();
        var ua = UserAgentInfo.Parse(batch.Ua ?? ctx.Request.Headers.UserAgent.ToString());
        if (ua.IsBot) return rows;
        var ip = ClientIp(ctx);
        var now = DateTime.UtcNow;
        foreach (var e in batch.Events)
        {
            var kind = e.Type switch
            {
                "page" or "view" => AnalyticsKind.Pageview,
                "track" => AnalyticsKind.Event,
                "click" => AnalyticsKind.Click,
                "scroll" => AnalyticsKind.Scroll,
                _ => (byte)0,
            };
            if (kind == 0 || (kind == AnalyticsKind.Pageview && e.NoAudience == true)) continue;
            var ts = e.Ts > 0 ? DateTime.UnixEpoch.AddMilliseconds(e.Ts) : now;
            if (ts > now.AddMinutes(5) || ts < now.AddDays(-1)) ts = now; // horloge du poste fantaisiste
            var row = Base(service, batch.Env, kind, ts, ip, batch.Ua, batch.User, e.Path, e.Query, batch.Hostname, batch.Lang, ctx);
            row.Title = Clip(e.Title, 300);
            row.ReferrerDomain = ReferrerDomain(e.Referrer, batch.Hostname);
            row.Browser = ua.Browser;
            row.Os = ua.Os;
            row.Device = kind is AnalyticsKind.Click or AnalyticsKind.Scroll ? UserAgentInfo.Parse(batch.Ua, e.Vw).Device : ua.Device;
            row.Screen = Clip(batch.Screen, 20);
            if (kind == AnalyticsKind.Event)
            {
                row.EventName = Clip(e.Name, 100);
                row.EventData = EventData(e.Data);
                if (row.EventName is null) continue;
            }
            if (kind is AnalyticsKind.Click or AnalyticsKind.Scroll)
            {
                row.Vw = Positive(e.Vw, 10_000);
                row.Vh = Positive(e.Vh, 10_000);
                row.DocH = Positive(e.Dh, 100_000);
            }
            if (kind == AnalyticsKind.Click)
            {
                if (e.X is not (>= 0 and <= 1) || e.Y is not (>= 0 and <= 100_000)) continue;
                row.X = (int)Math.Round(e.X.Value * 10_000);
                row.Y = (int)e.Y.Value;
                row.Selector = Clip(e.Selector, 200);
                row.Label = Clip(e.Label, 60);
                row.Rage = e.Rage == true;
                row.Dead = e.Dead == true;
            }
            if (kind == AnalyticsKind.Scroll)
            {
                if (e.Depth is not (>= 0 and <= 100)) continue;
                row.Depth = (byte)e.Depth.Value;
            }
            rows.Add(row);
        }
        return rows;
    }

    /// <summary>Lignes d'audience envoyées par une application (clé serveur) : pages vues et événements.</summary>
    public List<AnalyticsRow> FromServer(ServerAnalyticsBatch batch, HttpContext ctx)
    {
        var service = Clip(batch.Service, 80) ?? "application";
        var rows = new List<AnalyticsRow>();
        var now = DateTime.UtcNow;
        foreach (var e in batch.Events.Take(1000))
        {
            // Sans User-Agent (événement déclenché hors requête) : visiteur inconnu mais pas un robot.
            var ua = e.UserAgent is null ? new UserAgentInfo(null, null, "desktop", false) : UserAgentInfo.Parse(e.UserAgent);
            if (ua.IsBot) continue;
            var kind = e.Type == "event" ? AnalyticsKind.Event : AnalyticsKind.Pageview;
            var ts = e.Ts > 0 ? DateTime.UnixEpoch.AddMilliseconds(e.Ts) : now;
            if (ts > now.AddMinutes(5) || ts < now.AddDays(-1)) ts = now;
            var (path, query) = SplitPath(e.Path);
            var row = Base(service, batch.Env, kind, ts, e.Ip, e.UserAgent, e.User, path, query, e.Hostname, e.Language, ctx);
            row.Source = "server";
            row.Title = Clip(e.Title, 300);
            row.ReferrerDomain = ReferrerDomain(e.Referrer, e.Hostname);
            row.Browser = ua.Browser;
            row.Os = ua.Os;
            row.Device = ua.Device;
            if (kind == AnalyticsKind.Event)
            {
                row.EventName = Clip(e.Name, 100);
                row.EventData = EventData(e.Data);
                if (row.EventName is null) continue;
            }
            rows.Add(row);
        }
        return rows;
    }

    public async Task StoreAsync(List<AnalyticsRow> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return;
        await storage.Analytics.IngestAsync(rows, AnalyticsSchema.Encode(rows), ct);
    }

    private AnalyticsRow Base(string service, string? env, byte kind, DateTime ts, string? ip, string? ua, string? user, string? path, string? query,
        string? hostname, string? language, HttpContext ctx)
    {
        // Utilisateur connecté : pseudonyme stable, commun à tous les services (utilisateurs uniques). Son visiteur en dérive,
        // propre au service comme l'empreinte anonyme : il compte une seule fois d'un jour et d'un appareil à l'autre,
        // et des collègues derrière la même adresse (proxy, Citrix) restent distincts.
        var userKey = identity.User(user);
        var visitor = userKey is null ? identity.Visitor(service, ip, ua, ts) : identity.UserVisitor(service, userKey);
        var utm = ParseQuery(query);
        var lang = Clip(language, 35);
        return new AnalyticsRow
        {
            Ts = ts,
            Service = service,
            Env = Clip(env, 40),
            Kind = kind,
            Visitor = visitor,
            UserKey = userKey,
            Visit = identity.Visit(visitor, ts),
            Path = NormalizePath(path),
            Hostname = Clip(StripWww(hostname?.ToLowerInvariant()), 100),
            UtmSource = Clip(utm.GetValueOrDefault("utm_source") ?? utm.GetValueOrDefault("ref"), 100),
            UtmMedium = Clip(utm.GetValueOrDefault("utm_medium"), 100),
            UtmCampaign = Clip(utm.GetValueOrDefault("utm_campaign"), 100),
            Language = lang,
            Country = Country(ctx, lang),
        };
    }

    public static string ClientIp(HttpContext ctx)
    {
        var forwarded = ctx.Request.Headers["X-Forwarded-For"].ToString();
        return (forwarded.Length > 0 ? forwarded.Split(',')[0] : ctx.Connection.RemoteIpAddress?.ToString() ?? "").Trim();
    }

    /// <summary>Pays : en-tête du CDN (Cloudflare, Vercel, CloudFront…), sinon région déclarée par le navigateur (fr-BE → BE).</summary>
    private static string? Country(HttpContext ctx, string? language)
    {
        foreach (var h in CountryHeaders)
        {
            var v = ctx.Request.Headers[h].ToString();
            if (v.Length == 2 && char.IsAsciiLetter(v[0]) && char.IsAsciiLetter(v[1]) && !v.Equals("XX", StringComparison.OrdinalIgnoreCase))
                return v.ToUpperInvariant();
        }
        var m = LanguageRegion().Match(language ?? "");
        return m.Success ? m.Groups[1].Value.ToUpperInvariant() : null;
    }

    private static string? ReferrerDomain(string? referrer, string? hostname)
    {
        if (!Uri.TryCreate(referrer, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return null;
        var domain = StripWww(uri.Host.ToLowerInvariant());
        var site = StripWww(hostname?.ToLowerInvariant())?.Split(':')[0];
        return string.Equals(domain, site, StringComparison.Ordinal) ? null : Clip(domain, 100);
    }

    private static (string? Path, string? Query) SplitPath(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return (null, null);
        if (Uri.TryCreate(raw, UriKind.Absolute, out var abs) && abs.Scheme is "http" or "https") return (abs.AbsolutePath, abs.Query);
        var q = raw.IndexOf('?');
        return q < 0 ? (raw, null) : (raw[..q], raw[q..]);
    }

    private static string NormalizePath(string? path)
    {
        if (string.IsNullOrEmpty(path)) return "/";
        var cut = path.IndexOfAny(['?', '#']);
        if (cut >= 0) path = path[..cut];
        try { path = Uri.UnescapeDataString(path); } catch (UriFormatException) { /* chemin laissé tel quel */ }
        if (!path.StartsWith('/')) path = "/" + path;
        return path.Length > 300 ? path[..300] : path;
    }

    private static Dictionary<string, string> ParseQuery(string? query)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(query)) return result;
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split('=', 2);
            if (kv.Length != 2) continue;
            var key = Uri.UnescapeDataString(kv[0]);
            // Seuls les paramètres de campagne sont conservés : le reste peut contenir des données personnelles.
            if (key.StartsWith("utm_", StringComparison.OrdinalIgnoreCase) || key == "ref")
                result[key] = Uri.UnescapeDataString(kv[1].Replace('+', ' '));
        }
        return result;
    }

    private static string? EventData(JsonElement? data)
    {
        if (data is not { ValueKind: JsonValueKind.Object } d) return null;
        var json = d.GetRawText();
        return json.Length <= 4000 ? json : null;
    }

    private static string? StripWww(string? host) => host is not null && host.StartsWith("www.", StringComparison.Ordinal) ? host[4..] : host;

    private static int? Positive(int? v, int max) => v is > 0 ? Math.Min(v.Value, max) : null;

    private static string? Clip(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        return s.Length > max ? s[..max] : s;
    }
}
