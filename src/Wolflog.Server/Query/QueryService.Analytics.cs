using System.Text.RegularExpressions;

namespace Wolflog.Server.Query;

/// <summary>Audience web : visiteurs anonymes, utilisateurs identifiés (pseudonymes), pages vues, sources, événements, temps réel et entonnoirs.</summary>
public sealed partial class QueryService
{
    /// <summary>Ventilations disponibles : clé publique → expression SQL.</summary>
    private static readonly HashSet<string> PageBreakdowns = ["page", "title", "host"];
    private static readonly HashSet<string> SourceBreakdowns = ["referrer", "utm_source", "utm_medium", "utm_campaign"];

    private (string Source, List<string> Where) AnalyticsScope(DateTime from, DateTime to, AnalyticsFilter f, string? extra = null)
    {
        var snap = storage.Analytics.Snapshot;
        var source = storage.Analytics.Source(snap, idx => Overlaps(idx, from, to) && (f.Service is null || idx.Services.Contains(f.Service)));
        var where = TimeFilter(from, to);
        if (f.Service is not null) where.Add($"service = {Sql.Str(f.Service)}");
        foreach (var (key, value) in f.Values)
            where.Add($"coalesce({AnalyticsFilter.Dimensions[key]}, '') = {Sql.Str(value)}");
        if (extra is not null) where.Add(extra);
        return (source, where);
    }

    // ------------------------------------------------------------------ indicateurs

    public AnalyticsComparison AnalyticsSummary(DateTime from, DateTime to, AnalyticsFilter f, CancellationToken ct)
    {
        var span = to - from;
        return new AnalyticsComparison(Summary(from, to, f, ct), Summary(from - span, from, f, ct));
    }

    private AnalyticsSummary Summary(DateTime from, DateTime to, AnalyticsFilter f, CancellationToken ct)
    {
        var (source, where) = AnalyticsScope(from, to, f, "kind IN (1, 2)");
        var summary = new AnalyticsSummary(0, 0, 0, 0, 0, 0, 0, 0, 0);
        // Une visite appartient à un seul visiteur, donc à un seul utilisateur (ou à aucun).
        Read($"""
            SELECT count(DISTINCT visitor), count(*), CAST(coalesce(sum(pv), 0) AS BIGINT), CAST(coalesce(sum(ev), 0) AS BIGINT),
                   count(*) FILTER (WHERE pv <= 1), CAST(coalesce(sum(dur), 0) AS DOUBLE),
                   CAST(coalesce(sum(revenue), 0) AS DOUBLE), count(DISTINCT user_key)
            FROM (SELECT visit, any_value(visitor) AS visitor, any_value(user_key) AS user_key,
                         count(*) FILTER (WHERE kind = 1) AS pv, count(*) FILTER (WHERE kind = 2) AS ev,
                         date_diff('second', min(ts), max(ts)) AS dur,
                         sum(TRY_CAST(json_extract_string(event_data, '$.revenue') AS DOUBLE)) AS revenue
                  FROM {source} WHERE {string.Join(" AND ", where)} GROUP BY visit)
            """, ct, r => summary = new AnalyticsSummary(r.GetInt64(0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4), r.GetDouble(5), r.GetDouble(6),
            r.GetInt64(7), 0));
        return summary.Users > 0 ? summary with { NewUsers = NewUsers(from, to, f, ct) } : summary;
    }

    /// <summary>Utilisateurs vus pour la première fois sur la période : tout l'historique conservé avant elle est parcouru.</summary>
    private long NewUsers(DateTime from, DateTime to, AnalyticsFilter f, CancellationToken ct)
    {
        var (source, where) = AnalyticsScope(DateTime.MinValue, to, f, "kind IN (1, 2) AND user_key IS NOT NULL");
        long count = 0;
        Read($"""
            SELECT count(*) FROM (SELECT min(ts) AS first FROM {source} WHERE {string.Join(" AND ", where)} GROUP BY user_key)
            WHERE first >= {Sql.Ts(from)}
            """, ct, r => count = r.GetInt64(0));
        return count;
    }

    // ------------------------------------------------------------------ série temporelle

    public AnalyticsSeries AnalyticsSeries(DateTime from, DateTime to, AnalyticsFilter f, bool compare, CancellationToken ct)
    {
        var step = StepFor(from, to, 48, 60);
        var stepMs = step * 1000L;
        var (visitors, users, pageviews) = SeriesCounts(from, to, f, stepMs, ct);
        var times = new List<DateTime>();
        var v = new List<long>();
        var u = new List<long>();
        var p = new List<long>();
        for (var t = UnixMs(from) / stepMs * stepMs; t <= UnixMs(to); t += stepMs)
        {
            times.Add(DateTime.UnixEpoch.AddMilliseconds(t));
            v.Add(visitors.GetValueOrDefault(t));
            u.Add(users.GetValueOrDefault(t));
            p.Add(pageviews.GetValueOrDefault(t));
        }

        List<long>? previous = null;
        if (compare)
        {
            // Période précédente décalée sur la même grille pour être superposée.
            var span = to - from;
            var shiftMs = UnixMs(from) - UnixMs(from - span);
            var (pv, _, _) = SeriesCounts(from - span, from, f, stepMs, ct);
            previous = times.Select(t => pv.GetValueOrDefault((UnixMs(t) - shiftMs) / stepMs * stepMs)).ToList();
        }
        return new AnalyticsSeries(step, times, v, u, p, previous);
    }

    private (Dictionary<long, long> Visitors, Dictionary<long, long> Users, Dictionary<long, long> Pageviews) SeriesCounts(
        DateTime from, DateTime to, AnalyticsFilter f, long stepMs, CancellationToken ct)
    {
        var (source, where) = AnalyticsScope(from, to, f, "kind IN (1, 2)");
        var visitors = new Dictionary<long, long>();
        var users = new Dictionary<long, long>();
        var pageviews = new Dictionary<long, long>();
        Read($"""
            SELECT (epoch_ms(ts) // {stepMs}) * {stepMs} AS b, count(DISTINCT visitor), count(DISTINCT user_key), count(*) FILTER (WHERE kind = 1)
            FROM {source} WHERE {string.Join(" AND ", where)} GROUP BY b
            """, ct, r =>
        {
            visitors[r.GetInt64(0)] = r.GetInt64(1);
            users[r.GetInt64(0)] = r.GetInt64(2);
            pageviews[r.GetInt64(0)] = r.GetInt64(3);
        });
        return (visitors, users, pageviews);
    }

    // ------------------------------------------------------------------ ventilations

    public List<AnalyticsBreakdownRow> AnalyticsBreakdown(DateTime from, DateTime to, AnalyticsFilter f, string dimension, int limit, CancellationToken ct)
    {
        limit = Math.Clamp(limit, 1, 500);
        var rows = new List<AnalyticsBreakdownRow>();
        void Collect(string sql) => Read(sql, ct, r => rows.Add(new AnalyticsBreakdownRow(Str(r, 0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3))));

        if (dimension is "entry" or "exit")
        {
            var (src, w) = AnalyticsScope(from, to, f, "kind = 1");
            var pick = dimension == "entry" ? "arg_min" : "arg_max";
            Collect($"""
                SELECT p, count(*) AS n, count(*), count(DISTINCT u)
                FROM (SELECT visit, {pick}(path, ts) AS p, any_value(user_key) AS u FROM {src} WHERE {string.Join(" AND ", w)} GROUP BY visit)
                GROUP BY p ORDER BY n DESC LIMIT {limit}
                """);
            return rows;
        }
        if (!AnalyticsFilter.Dimensions.TryGetValue(dimension, out var col)) return rows;

        var extra = dimension == "event" ? "kind = 2" : PageBreakdowns.Contains(dimension) ? "kind = 1" : "kind IN (1, 2)";
        if (dimension == "event" || SourceBreakdowns.Contains(dimension)) extra += $" AND {col} IS NOT NULL";
        var (source, where) = AnalyticsScope(from, to, f, extra);
        var count = dimension == "event" ? "count(*)" : "count(*) FILTER (WHERE kind = 1)";
        var order = dimension == "event" || PageBreakdowns.Contains(dimension) ? "n DESC, v DESC" : "v DESC, n DESC";
        Collect($"""
            SELECT {col} AS dim, count(DISTINCT visitor) AS v, {count} AS n, count(DISTINCT user_key)
            FROM {source} WHERE {string.Join(" AND ", where)} GROUP BY dim ORDER BY {order} LIMIT {limit}
            """);
        return rows;
    }

    public List<AnalyticsEventProperty> AnalyticsEventProperties(DateTime from, DateTime to, AnalyticsFilter f, string eventName, CancellationToken ct)
    {
        var (source, where) = AnalyticsScope(from, to, f, $"kind = 2 AND event_name = {Sql.Str(eventName)} AND event_data IS NOT NULL");
        var list = new List<AnalyticsEventProperty>();
        Read($"""
            SELECT k, json_extract_string(event_data, '$."' || replace(k, '"', '') || '"') AS v, count(*) AS n
            FROM (SELECT event_data, unnest(json_keys(event_data)) AS k FROM {source} WHERE {string.Join(" AND ", where)})
            GROUP BY k, v ORDER BY k, n DESC LIMIT 300
            """, ct, r => list.Add(new AnalyticsEventProperty(r.GetString(0), Str(r, 1), r.GetInt64(2))));
        return list;
    }

    // ------------------------------------------------------------------ temps réel

    public AnalyticsRealtime AnalyticsRealtime(AnalyticsFilter f, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var from = now.AddMinutes(-30);
        var (source, where) = AnalyticsScope(from, now.AddMinutes(1), f, "kind IN (1, 2)");
        var w = string.Join(" AND ", where);

        long active = 0, visitors = 0, activeUsers = 0, users = 0;
        var recently = $"ts >= {Sql.Ts(now.AddMinutes(-5))}";
        Read($"""
            SELECT count(DISTINCT visitor) FILTER (WHERE {recently}), count(DISTINCT visitor),
                   count(DISTINCT user_key) FILTER (WHERE {recently}), count(DISTINCT user_key)
            FROM {source} WHERE {w}
            """, ct, r =>
        {
            active = r.GetInt64(0);
            visitors = r.GetInt64(1);
            activeUsers = r.GetInt64(2);
            users = r.GetInt64(3);
        });

        var perMinute = new long[30];
        var start = UnixMs(now) / 60_000 * 60_000 - 29 * 60_000L;
        Read($"SELECT (epoch_ms(ts) // 60000) * 60000 AS m, count(*) FROM {source} WHERE {w} AND kind = 1 GROUP BY m", ct, r =>
        {
            var i = (int)((r.GetInt64(0) - start) / 60_000);
            if (i is >= 0 and < 30) perMinute[i] = r.GetInt64(1);
        });

        var recent = new List<AnalyticsLiveEvent>();
        Read($"""
            SELECT ts, kind, service, path, event_name, referrer_domain, country, browser, os, device, visitor, user_key
            FROM {source} WHERE {w} ORDER BY ts DESC LIMIT 50
            """, ct, r => recent.Add(new AnalyticsLiveEvent(Utc(r.GetDateTime(0)), r.GetByte(1), r.GetString(2), r.GetString(3), Str(r, 4),
            Str(r, 5), Str(r, 6), Str(r, 7), Str(r, 8), Str(r, 9), r.GetString(10)[..6], Str(r, 11)?[..6])));

        var window = now.AddMinutes(1);
        return new AnalyticsRealtime(active, visitors, activeUsers, users, [.. perMinute], recent,
            AnalyticsBreakdown(from, window, f, "page", 8, ct),
            AnalyticsBreakdown(from, window, f, "referrer", 8, ct),
            AnalyticsBreakdown(from, window, f, "country", 8, ct));
    }

    // ------------------------------------------------------------------ entonnoirs

    /// <summary>
    /// Visiteurs ayant franchi chaque étape dans l'ordre, dans la fenêtre donnée après la première étape.
    /// Les valeurs acceptent le joker * (ex. /blog/*).
    /// </summary>
    public AnalyticsFunnel AnalyticsFunnel(DateTime from, DateTime to, AnalyticsFilter f, IReadOnlyList<AnalyticsFunnelStep> input, int windowMinutes, CancellationToken ct)
    {
        var steps = input.Where(s => s.Type is "url" or "event" && !string.IsNullOrWhiteSpace(s.Value)).Take(10)
            .Select(s => s with { Value = s.Value.Trim() }).ToList();
        if (steps.Count < 2) return new AnalyticsFunnel([], []);
        var patterns = steps.Select(s => new Regex("^" + Regex.Escape(s.Value).Replace("\\*", ".*") + "$", RegexOptions.CultureInvariant)).ToArray();

        var conditions = steps.Select(s => s.Type == "url"
            ? $"(kind = 1 AND path GLOB {Sql.Str(s.Value)})"
            : $"(kind = 2 AND event_name GLOB {Sql.Str(s.Value)})");
        var (source, where) = AnalyticsScope(from, to, f, $"({string.Join(" OR ", conditions)})");

        var window = TimeSpan.FromMinutes(Math.Max(1, windowMinutes));
        var counts = new long[steps.Count];
        string? visitor = null;
        int reached = 0;
        DateTime started = default;
        void Finish() { for (var i = 0; i < reached; i++) counts[i]++; }

        Read($"SELECT visitor, ts, kind, path, event_name FROM {source} WHERE {string.Join(" AND ", where)} ORDER BY visitor, ts", ct, r =>
        {
            var v = r.GetString(0);
            if (v != visitor)
            {
                if (visitor is not null) Finish();
                visitor = v;
                reached = 0;
            }
            if (reached >= steps.Count) return;
            var ts = r.GetDateTime(1);
            if (reached > 0 && ts - started > window) return;
            var step = steps[reached];
            var value = step.Type == "url" ? (r.GetByte(2) == AnalyticsKind.Pageview ? r.GetString(3) : null) : r.GetByte(2) == AnalyticsKind.Event ? Str(r, 4) : null;
            if (value is null || !patterns[reached].IsMatch(value)) return;
            if (reached == 0) started = ts;
            reached++;
        });
        if (visitor is not null) Finish();
        return new AnalyticsFunnel(steps, [.. counts]);
    }
}
