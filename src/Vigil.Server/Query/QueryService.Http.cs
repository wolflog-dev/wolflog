using Vigil.Server.Storage;

namespace Vigil.Server.Query;

public sealed record HttpRequestItem(
    DateTime Ts, string TraceId, string SpanId, string Service, string Method, string? Route, string Target,
    int? Status, double DurationMs, bool Error, bool HasBody);

public sealed record HttpSummary(long Count, double RatePerSecond, long Errors, double ErrorRate, double? P50Ms, double? P95Ms, double? P99Ms);

public sealed record HttpFilter(string? Service, string? Text, string? StatusClass, double? MinDurationMs, bool Outgoing);

/// <summary>Requêtes HTTP (spans serveur ou client) : liste, séries pour les tableaux de bord, synthèse.</summary>
public sealed partial class QueryService
{
    // Colonnes extraites des attributs sémantiques OpenTelemetry HTTP.
    private static string HttpProjection(bool outgoing) => $"""
        ts, trace_id, span_id, service, duration_ns, status_code,
        coalesce(json_extract_string(attributes, '$."http.request.method"'), split_part(name, ' ', 1)) AS method,
        {(outgoing
            ? "json_extract_string(attributes, '$.\"server.address\"')"
            : "json_extract_string(attributes, '$.\"http.route\"')")} AS route,
        coalesce({(outgoing ? "json_extract_string(attributes, '$.\"url.full\"')," : "")}
                 json_extract_string(attributes, '$."url.path"'), name) AS target,
        TRY_CAST(json_extract_string(attributes, '$."http.response.status_code"') AS INTEGER) AS status,
        (json_extract_string(attributes, '$."http.request.body"') IS NOT NULL
         OR json_extract_string(attributes, '$."http.response.body"') IS NOT NULL) AS has_body
        """;

    private const string IsError = "(status >= 500 OR status_code = 2)";

    private string HttpSource(DateTime from, DateTime to, HttpFilter f)
    {
        var snap = storage.Spans.Snapshot;
        var source = storage.Spans.Source(snap, idx => Overlaps(idx, from, to) && (f.Service is null || idx.Services.Contains(f.Service)));
        var where = TimeFilter(from, to);
        where.Add(f.Outgoing ? "kind = 3" : "kind = 2");
        if (!string.IsNullOrEmpty(f.Service)) where.Add($"service = {Sql.Str(f.Service)}");
        if (f.MinDurationMs is > 0) where.Add($"duration_ns >= {(long)(f.MinDurationMs.Value * 1_000_000)}");

        var outer = new List<string> { "method IS NOT NULL" };
        if (!string.IsNullOrWhiteSpace(f.Text))
        {
            var like = Sql.Like(f.Text.Trim());
            outer.Add($"(target ILIKE {like} ESCAPE '\\' OR route ILIKE {like} ESCAPE '\\')");
        }
        switch (f.StatusClass)
        {
            case "2xx": outer.Add("status BETWEEN 200 AND 299"); break;
            case "3xx": outer.Add("status BETWEEN 300 AND 399"); break;
            case "4xx": outer.Add("status BETWEEN 400 AND 499"); break;
            case "5xx": outer.Add("status >= 500"); break;
            case "errors": outer.Add(IsError); break;
        }
        return $"(SELECT * FROM (SELECT {HttpProjection(f.Outgoing)} FROM {source} WHERE {string.Join(" AND ", where)}) WHERE {string.Join(" AND ", outer)})";
    }

    public IReadOnlyList<HttpRequestItem> HttpRequests(DateTime from, DateTime to, HttpFilter f, int limit, CancellationToken ct, int maxLimit = 2000)
    {
        var list = new List<HttpRequestItem>();
        Read($"""
            SELECT ts, trace_id, span_id, service, method, route, target, status, duration_ns, {IsError}, has_body
            FROM {HttpSource(from, to, f)} ORDER BY ts DESC LIMIT {Math.Clamp(limit, 1, maxLimit)}
            """, ct, r => list.Add(new HttpRequestItem(
            Utc(r.GetDateTime(0)), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), Str(r, 5), r.GetString(6),
            r.IsDBNull(7) ? null : r.GetInt32(7), r.GetInt64(8) / 1_000_000.0, !r.IsDBNull(9) && r.GetBoolean(9), r.GetBoolean(10))));
        return list;
    }

    public HttpSummary HttpSummary(DateTime from, DateTime to, HttpFilter f, CancellationToken ct)
    {
        var seconds = Math.Max(1, (to - from).TotalSeconds);
        HttpSummary result = new(0, 0, 0, 0, null, null, null);
        Read($"""
            SELECT count(*), count(*) FILTER (WHERE {IsError}),
                   quantile_cont(duration_ns, 0.5), quantile_cont(duration_ns, 0.95), quantile_cont(duration_ns, 0.99)
            FROM {HttpSource(from, to, f)}
            """, ct, r =>
        {
            var count = r.GetInt64(0);
            var errors = r.GetInt64(1);
            double? Ms(int i) => r.IsDBNull(i) ? null : r.GetDouble(i) / 1_000_000.0;
            result = new HttpSummary(count, count / seconds, errors, count == 0 ? 0 : 100.0 * errors / count, Ms(2), Ms(3), Ms(4));
        });
        return result;
    }

    /// <summary>Séries temporelles "RED" (débit, erreurs, durée) calculées depuis les spans HTTP.</summary>
    public MetricData HttpSeries(DateTime from, DateTime to, HttpFilter f, string? stat, string? groupBy, CancellationToken ct)
    {
        var step = StepFor(from, to, 90, minimum: 10);
        var stepMs = step * 1000L;
        stat = stat is "rate" or "errors" or "errorRate" or "p50" or "p95" or "p99" or "avg" ? stat : "rate";
        var agg = stat switch
        {
            "rate" => $"count(*) / {step}.0",
            "errors" => $"count(*) FILTER (WHERE {IsError}) / {step}.0",
            "errorRate" => $"100.0 * count(*) FILTER (WHERE {IsError}) / count(*)",
            "p50" => "quantile_cont(duration_ns, 0.5) / 1e6",
            "p95" => "quantile_cont(duration_ns, 0.95) / 1e6",
            "p99" => "quantile_cont(duration_ns, 0.99) / 1e6",
            _ => "avg(duration_ns) / 1e6",
        };
        var group = groupBy switch
        {
            "service" => "service",
            "status" => "coalesce(CAST(status AS VARCHAR), '–')",
            "method" => "method",
            "none" or null or "" => "'total'",
            _ => "coalesce(route, target)",
        };

        var values = new Dictionary<(long, string), double?>();
        var weight = new Dictionary<string, long>();
        Read($"SELECT (epoch_ms(ts) // {stepMs}) * {stepMs}, {group}, {agg}, count(*) FROM {HttpSource(from, to, f)} GROUP BY 1, 2", ct, r =>
        {
            var g = r.IsDBNull(1) ? "–" : r.GetString(1);
            values[(r.GetInt64(0), g)] = r.IsDBNull(2) ? null : r.GetDouble(2);
            weight[g] = weight.GetValueOrDefault(g) + r.GetInt64(3);
        });

        var times = new List<long>();
        for (var t = UnixMs(from) / stepMs * stepMs; t <= UnixMs(to); t += stepMs) times.Add(t);
        // Les 10 groupes les plus fréquents : au-delà, un graphique devient illisible.
        var series = weight.OrderByDescending(kv => kv.Value).Take(10).Select(kv => kv.Key)
            .Select(g => new MetricSeries(stat, g, times.Select(t => values.TryGetValue((t, g), out var v) ? v : (stat is "rate" or "errors" ? 0 : null)).ToList()))
            .ToList();
        var unit = stat switch { "rate" or "errors" => "req/s", "errorRate" => "%", _ => "ms" };
        return new MetricData("http", stat, unit, step, times.Select(t => DateTime.UnixEpoch.AddMilliseconds(t)).ToList(), series);
    }

    /// <summary>Environnements connus (7 derniers jours), pour le sélecteur de l'interface.</summary>
    public IReadOnlyList<string> Environments(CancellationToken ct)
    {
        var from = DateTime.UtcNow.AddDays(-7);
        var envs = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var store in new ISignalStore[] { storage.Logs, storage.Spans })
        {
            var source = store == storage.Logs
                ? storage.Logs.Source(storage.Logs.Snapshot, idx => idx.MaxTs >= from)
                : storage.Spans.Source(storage.Spans.Snapshot, idx => idx.MaxTs >= from);
            Read($"SELECT DISTINCT env FROM {source} WHERE ts >= {Sql.Ts(from)} AND env IS NOT NULL", ct, r => envs.Add(r.GetString(0)));
        }
        return envs.ToList();
    }
}
