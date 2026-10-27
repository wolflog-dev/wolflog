namespace Wolflog.Server.Query;

/// <summary>Requêtes HTTP (spans serveur ou client) : liste, séries pour les tableaux de bord, synthèse.</summary>
public sealed partial class QueryService
{
    // Colonnes extraites des attributs sémantiques OpenTelemetry HTTP. Celles qui ne servent pas à une requête
    // (corps, type de route…) ne sont pas calculées : DuckDB élague les colonnes inutilisées.
    private static string HttpProjection(bool outgoing) => $"""
        ts, trace_id, span_id, service, duration_ns, status_code, attributes,
        coalesce(json_extract_string(attributes, '$."http.request.method"'), split_part(name, ' ', 1)) AS method,
        {(outgoing
            ? "json_extract_string(attributes, '$.\"server.address\"')"
            : "json_extract_string(attributes, '$.\"http.route\"')")} AS route,
        coalesce({(outgoing ? "json_extract_string(attributes, '$.\"url.full\"')," : "")}
                 json_extract_string(attributes, '$."url.path"'), name) AS target,
        coalesce(json_extract_string(attributes, '$."server.address"'), json_extract_string(attributes, '$."url.domain"')) AS host,
        TRY_CAST(json_extract_string(attributes, '$."http.response.status_code"') AS INTEGER) AS status,
        json_extract_string(attributes, '$."http.request.body"') AS req_body,
        json_extract_string(attributes, '$."http.response.body"') AS res_body,
        (req_body IS NOT NULL OR res_body IS NOT NULL) AS has_body,
        {KindExpression} AS kind
        """;

    /// <summary>
    /// Type de route : santé (health, ready, live, ping, metrics), fichier statique (extension), API (/api, graphql,
    /// /v1…, réponse JSON, méthode autre que GET) ou page (réponse HTML, sinon GET).
    /// </summary>
    private const string KindExpression = """
        CASE
          WHEN regexp_matches(lower(split_part(coalesce(route, target), '?', 1)), '(^|/)(health|healthz|healthcheck|health-check|ready|readyz|readiness|live|livez|liveness|ping|alive|metrics)/?$') THEN 'health'
          WHEN regexp_matches(lower(split_part(target, '?', 1)), '\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|eot|otf|txt|xml|webmanifest|mp4|webm|mp3|pdf|zip)$') THEN 'static'
          WHEN regexp_matches(lower(coalesce(route, target)), '(^|/)(api|graphql|odata|hubs?|signalr|grpc|rpc|v[0-9]+)(/|$)')
            OR coalesce(json_extract_string(attributes, '$."http.response.header.content-type"'), '') ILIKE '%json%' THEN 'api'
          WHEN coalesce(json_extract_string(attributes, '$."http.response.header.content-type"'), '') ILIKE '%text/html%' THEN 'page'
          WHEN upper(method) <> 'GET' THEN 'api'
          ELSE 'page'
        END
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
        // Barre de recherche : mots, phrases, exclusions et champs (voir HttpSearch).
        outer.AddRange(HttpSearch.Conditions(f.Text));
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

    /// <summary>
    /// Requêtes, des plus récentes aux plus anciennes. Pagination par curseur (date, identifiant de span) dans les deux
    /// sens : <paramref name="before"/> = plus anciennes que cette requête, <paramref name="after"/> = plus récentes ; deux
    /// requêtes à la même microseconde ne sont ni sautées ni répétées d'une page à l'autre.
    /// </summary>
    public IReadOnlyList<HttpRequestItem> HttpRequests(DateTime from, DateTime to, HttpFilter f, int limit, CancellationToken ct, int maxLimit = 2000,
        (DateTime Ts, string SpanId)? before = null, (DateTime Ts, string SpanId)? after = null)
    {
        var list = new List<HttpRequestItem>();
        var where = new List<string>();
        if (before is { } b) where.Add($"(ts < {Sql.Ts(b.Ts)} OR (ts = {Sql.Ts(b.Ts)} AND span_id < {Sql.Str(b.SpanId)}))");
        if (after is { } a) where.Add($"(ts > {Sql.Ts(a.Ts)} OR (ts = {Sql.Ts(a.Ts)} AND span_id > {Sql.Str(a.SpanId)}))");
        var order = after is not null && before is null ? "ts ASC, span_id ASC" : "ts DESC, span_id DESC";
        Read($"""
            SELECT ts, trace_id, span_id, service, method, route, target, status, duration_ns, {IsError}, has_body, kind, host
            FROM {HttpSource(from, to, f)} {(where.Count > 0 ? "WHERE " + string.Join(" AND ", where) : "")}
            ORDER BY {order} LIMIT {Math.Clamp(limit, 1, maxLimit)}
            """, ct, r => list.Add(new HttpRequestItem(
            Utc(r.GetDateTime(0)), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), Str(r, 5), r.GetString(6),
            r.IsDBNull(7) ? null : r.GetInt32(7), r.GetInt64(8) / 1_000_000.0, !r.IsDBNull(9) && r.GetBoolean(9), r.GetBoolean(10),
            r.GetString(11), Str(r, 12))));
        // Plus récentes demandées : lues de la plus proche à la plus lointaine, rendues dans l'ordre de la liste.
        if (after is not null && before is null) list.Reverse();
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

    /// <summary>
    /// Séries temporelles "RED" (débit, erreurs, durée) calculées depuis les spans HTTP. <paramref name="match"/> :
    /// condition sur la réponse (syntaxe de recherche) ; percent = part des requêtes qui la remplissent, les autres
    /// calculs portent sur ces seules requêtes.
    /// </summary>
    public MetricData HttpSeries(DateTime from, DateTime to, HttpFilter f, string? stat, string? groupBy, CancellationToken ct, string? match = null)
    {
        var step = StepFor(from, to, 90, minimum: 10);
        var stepMs = step * 1000L;
        stat = stat is "rate" or "count" or "errors" or "errorRate" or "percent" or "p50" or "p90" or "p95" or "p99" or "avg" or "max" ? stat : "rate";
        var m = MatchCondition(match);
        var agg = stat switch
        {
            "rate" => $"count(*) FILTER (WHERE {m}) / {step}.0",
            "count" => $"count(*) FILTER (WHERE {m})",
            "errors" => $"count(*) FILTER (WHERE ({m}) AND {IsError}) / {step}.0",
            "errorRate" => $"100.0 * count(*) FILTER (WHERE ({m}) AND {IsError}) / nullif(count(*) FILTER (WHERE {m}), 0)",
            "percent" => $"100.0 * count(*) FILTER (WHERE {m}) / count(*)",
            "p50" => $"quantile_cont(duration_ns, 0.5) FILTER (WHERE {m}) / 1e6",
            "p90" => $"quantile_cont(duration_ns, 0.9) FILTER (WHERE {m}) / 1e6",
            "p95" => $"quantile_cont(duration_ns, 0.95) FILTER (WHERE {m}) / 1e6",
            "p99" => $"quantile_cont(duration_ns, 0.99) FILTER (WHERE {m}) / 1e6",
            "max" => $"max(duration_ns) FILTER (WHERE {m}) / 1e6",
            _ => $"avg(duration_ns) FILTER (WHERE {m}) / 1e6",
        };
        var group = HttpGroup(groupBy) ?? "'total'";

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
            .Select(g => new MetricSeries(stat, g, times.Select(t => values.TryGetValue((t, g), out var v) ? v : (stat is "rate" or "errors" or "count" ? 0 : null)).ToList()))
            .ToList();
        var unit = stat switch { "rate" or "errors" => "req/s", "errorRate" or "percent" => "%", "count" => "", _ => "ms" };
        return new MetricData("http", stat, unit, step, times.Select(t => DateTime.UnixEpoch.AddMilliseconds(t)).ToList(), series);
    }

    /// <summary>
    /// Alertes HTTP : requêtes concernées (<paramref name="f"/>), celles qui remplissent la condition sur la réponse
    /// (<paramref name="match"/>), leurs erreurs et leurs durées, au total ou par groupe (les 100 plus fréquents).
    /// </summary>
    public IReadOnlyList<HttpAlertRow> HttpAlertRows(DateTime from, DateTime to, HttpFilter f, string? match, string? groupBy, CancellationToken ct)
    {
        var m = MatchCondition(match);
        var group = HttpGroup(groupBy);
        var rows = new List<HttpAlertRow>();
        Read($"""
            SELECT {group ?? "'total'"}, count(*), count(*) FILTER (WHERE {m}), count(*) FILTER (WHERE ({m}) AND {IsError}),
                   quantile_cont(duration_ns, 0.5) FILTER (WHERE {m}), quantile_cont(duration_ns, 0.9) FILTER (WHERE {m}),
                   quantile_cont(duration_ns, 0.95) FILTER (WHERE {m}), quantile_cont(duration_ns, 0.99) FILTER (WHERE {m}),
                   avg(duration_ns) FILTER (WHERE {m}), max(duration_ns) FILTER (WHERE {m})
            FROM {HttpSource(from, to, f)}
            {(group is null ? "" : "GROUP BY 1 ORDER BY 2 DESC LIMIT 100")}
            """, ct, r =>
        {
            double? Ms(int i) => r.IsDBNull(i) ? null : Convert.ToDouble(r.GetValue(i), CultureInfo.InvariantCulture) / 1_000_000.0;
            rows.Add(new HttpAlertRow(r.IsDBNull(0) ? "–" : r.GetString(0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3),
                Ms(4), Ms(5), Ms(6), Ms(7), Ms(8), Ms(9)));
        });
        return rows;
    }

    /// <summary>Condition sur la réponse (syntaxe de recherche des requêtes) ; sans condition : toutes.</summary>
    private static string MatchCondition(string? match) =>
        HttpSearch.Conditions(match) is { Count: > 0 } c ? string.Join(" AND ", c) : "true";

    /// <summary>Regroupement des requêtes : champ connu ou attribut ; null = pas de regroupement.</summary>
    private static string? HttpGroup(string? groupBy) => groupBy?.Trim() switch
    {
        null or "" or "none" or "total" => null,
        "service" => "service",
        "route" => "coalesce(route, split_part(target, '?', 1))",
        "path" or "target" => "split_part(target, '?', 1)",
        "status" => "coalesce(CAST(status AS VARCHAR), '–')",
        "method" => "method",
        "host" => "coalesce(host, '–')",
        "kind" or "type" => "kind",
        var key => $"coalesce(json_extract_string(attributes, {Sql.Str("$.\"" + key.Replace("\"", "") + "\"")}), '–')",
    };

    // Liste et activité des environnements : QueryService.Environments.cs (services visibles appliqués par TimeFilter).
}
