using System.Globalization;
using System.Text.Json;
using Vigil.Server.Storage;

namespace Vigil.Server.Query;

/// <summary>Requête libre construite dans l'interface (panneau "Requête personnalisée").</summary>
public sealed record CustomQuery(
    string Source, string? Filter, string Aggregate, string? Field, string? GroupBy, string View, int Limit, string? Service);

public sealed record CustomRow(string Group, double? Value, long Count);

public sealed record CustomResult(
    string View, string? Unit, int StepSeconds,
    IReadOnlyList<DateTime>? Times, IReadOnlyList<MetricSeries>? Series,
    IReadOnlyList<CustomRow>? Rows, double? Value, long Count);

public sealed record FieldInfo(string Key, string Label, string Kind, bool Builtin, long Seen);

public sealed record FieldValue(string Value, long Count);

/// <summary>
/// Moteur de requêtes génériques : n'importe quel champ (colonne ou attribut réellement présent dans les données)
/// peut servir de filtre, de valeur à calculer ou de regroupement.
/// </summary>
public sealed partial class QueryService
{
    private sealed record Builtin(string Label, string Sql, bool Numeric = false);

    // Champs "natifs" de chaque source ; tout autre nom est cherché dans les attributs JSON.
    private static readonly Dictionary<string, Dictionary<string, Builtin>> Builtins = new()
    {
        ["logs"] = new(StringComparer.OrdinalIgnoreCase)
        {
            ["service"] = new("Service", "service"),
            ["level"] = new("Niveau", "CASE WHEN severity >= 21 THEN 'fatal' WHEN severity >= 17 THEN 'error' WHEN severity >= 13 THEN 'warn' WHEN severity >= 9 OR severity = 0 THEN 'info' WHEN severity >= 5 THEN 'debug' ELSE 'trace' END"),
            ["host"] = new("Hôte", "host"),
            ["env"] = new("Environnement", "env"),
            ["version"] = new("Version", "version"),
            ["category"] = new("Catégorie (logger)", "category"),
            ["exception"] = new("Type d'exception", "exception_type"),
            ["crash"] = new("Crash", "CASE WHEN is_crash THEN 'oui' ELSE 'non' END"),
            ["template"] = new("Modèle du message", "coalesce(json_extract_string(attributes, '$.\"{OriginalFormat}\"'), left(body, 200))"),
        },
        ["spans"] = new(StringComparer.OrdinalIgnoreCase)
        {
            ["service"] = new("Service", "service"),
            ["name"] = new("Opération", "name"),
            ["kind"] = new("Type de span", "CASE kind WHEN 1 THEN 'interne' WHEN 2 THEN 'serveur' WHEN 3 THEN 'client' WHEN 4 THEN 'producteur' WHEN 5 THEN 'consommateur' ELSE 'autre' END"),
            ["status"] = new("Statut", "CASE status_code WHEN 2 THEN 'erreur' WHEN 1 THEN 'ok' ELSE 'non défini' END"),
            ["host"] = new("Hôte", "host"),
            ["env"] = new("Environnement", "env"),
            ["version"] = new("Version", "version"),
            ["duration"] = new("Durée (ms)", "duration_ns / 1e6", Numeric: true),
        },
        ["metrics"] = new(StringComparer.OrdinalIgnoreCase)
        {
            ["name"] = new("Métrique", "name"),
            ["service"] = new("Service", "service"),
            ["host"] = new("Hôte", "host"),
            ["env"] = new("Environnement", "env"),
            ["value"] = new("Valeur", "value", Numeric: true),
            ["sum"] = new("Somme (histogramme)", "sum", Numeric: true),
            ["count"] = new("Nombre (histogramme)", "count", Numeric: true),
            ["max"] = new("Maximum", "max", Numeric: true),
        },
    };

    private static readonly HashSet<string> NumericAggregates = ["sum", "avg", "min", "max", "p50", "p75", "p90", "p95", "p99"];

    private static string NormalizeSource(string? source) => source is "spans" or "metrics" ? source : "logs";

    private static string TextExpr(string source, string key) =>
        Builtins[source].TryGetValue(key, out var b) ? b.Sql : $"json_extract_string(attributes, {Sql.Str("$.\"" + key.Replace("\"", "") + "\"")})";

    private static string NumberExpr(string source, string key) =>
        Builtins[source].TryGetValue(key, out var b)
            ? (b.Numeric ? b.Sql : $"TRY_CAST({b.Sql} AS DOUBLE)")
            : $"TRY_CAST({TextExpr(source, key)} AS DOUBLE)";

    /// <summary>Source SQL + conditions pour une source, un filtre (syntaxe de recherche) et un service.</summary>
    private (string Source, List<string> Where) CustomSource(string source, string? filter, string? service, DateTime from, DateTime to)
    {
        var q = SearchQuery.Parse(filter);
        if (!string.IsNullOrEmpty(service)) q.Services.Add(service);
        var where = TimeFilter(from, to);

        if (source == "logs")
        {
            var logSource = storage.Logs.Source(storage.Logs.Snapshot, idx => Overlaps(idx, from, to) && q.MayMatch(idx));
            q.AppendLogFilters(where);
            return (logSource, where);
        }

        string src = source == "spans"
            ? storage.Spans.Source(storage.Spans.Snapshot, idx => Overlaps(idx, from, to) && (q.Services.Count == 0 || q.Services.Any(idx.Services.Contains)))
            : storage.Metrics.Source(storage.Metrics.Snapshot, idx => Overlaps(idx, from, to) && (q.Services.Count == 0 || q.Services.Any(idx.Services.Contains)));

        if (q.Services.Count > 0) where.Add($"service IN {Sql.List(q.Services)}");
        if (source == "spans")
        {
            if (q.MinSeverity >= 17) where.Add("status_code = 2");
            if (q.TraceId != null) where.Add($"trace_id = {Sql.Str(q.TraceId)}");
        }
        var textColumn = "name";
        foreach (var term in q.Terms) where.Add($"{textColumn} ILIKE {Sql.Like(term)} ESCAPE '\\'");
        foreach (var term in q.ExcludedTerms) where.Add($"{textColumn} NOT ILIKE {Sql.Like(term)} ESCAPE '\\'");
        foreach (var (column, value) in q.Columns)
            if (column is "host" or "env" or "version") where.Add(SearchQuery.ValueFilter(column, value));
        foreach (var (key, value) in q.Attributes)
            where.Add(SearchQuery.ValueFilter(TextExpr(source, key), value));
        return (src, where);
    }

    public CustomResult Custom(CustomQuery cq, DateTime from, DateTime to, CancellationToken ct)
    {
        var source = NormalizeSource(cq.Source);
        var agg = cq.Aggregate?.ToLowerInvariant() ?? "count";
        var needsField = NumericAggregates.Contains(agg);
        if (needsField && string.IsNullOrWhiteSpace(cq.Field))
            throw new ArgumentException("Choisissez le champ à calculer.");

        var (src, where) = CustomSource(source, cq.Filter, cq.Service, from, to);
        var value = needsField ? NumberExpr(source, cq.Field!) : "NULL";
        var view = cq.View is "timeseries" or "bars" or "top" or "table" or "stat" ? cq.View : "timeseries";
        var step = StepFor(from, to, 90, minimum: source == "metrics" ? 30 : 10);

        string AggSql(bool perBucket) => agg switch
        {
            "rate" => perBucket ? $"count(*) / {step}.0" : $"count(*) / {Math.Max(1, (to - from).TotalSeconds).ToString(CultureInfo.InvariantCulture)}",
            "distinct" => $"count(DISTINCT {TextExpr(source, cq.Field ?? "service")})",
            "sum" => $"sum(v)",
            "avg" => "avg(v)",
            "min" => "min(v)",
            "max" => "max(v)",
            "p50" => "quantile_cont(v, 0.5)",
            "p75" => "quantile_cont(v, 0.75)",
            "p90" => "quantile_cont(v, 0.9)",
            "p95" => "quantile_cont(v, 0.95)",
            "p99" => "quantile_cont(v, 0.99)",
            _ => "count(*)",
        };

        var group = string.IsNullOrWhiteSpace(cq.GroupBy) ? "'total'" : $"coalesce(CAST({TextExpr(source, cq.GroupBy)} AS VARCHAR), '(vide)')";
        var inner = $"SELECT *, {value} AS v, {group} AS g FROM {src} WHERE {string.Join(" AND ", where)}";
        if (needsField) inner = $"SELECT * FROM ({inner}) WHERE v IS NOT NULL";

        var unit = agg switch
        {
            "rate" => "/s",
            _ when needsField && string.Equals(cq.Field, "duration", StringComparison.OrdinalIgnoreCase) => "ms",
            _ => null,
        };
        // Valeur d'une métrique : unité déclarée par la métrique elle-même (ms, s, By…), si elle est unique.
        if (unit is null && source == "metrics" && needsField && cq.Field?.ToLowerInvariant() is "value" or "sum" or "min" or "max")
        {
            string? declared = null;
            Read($"SELECT min(unit), count(DISTINCT unit) FROM ({inner})", ct, r =>
            {
                if (!r.IsDBNull(0) && r.GetInt64(1) == 1) declared = r.GetString(0);
            });
            unit = declared is "1" or "" ? null : declared;
        }

        if (view == "stat")
        {
            double? v = null;
            long count = 0;
            Read($"SELECT {AggSql(false)}, count(*) FROM ({inner})", ct, r =>
            {
                v = r.IsDBNull(0) ? null : Convert.ToDouble(r.GetValue(0), CultureInfo.InvariantCulture);
                count = r.GetInt64(1);
            });
            return new CustomResult(view, unit, step, null, null, null, v, count);
        }

        if (view is "top" or "table")
        {
            var rows = new List<CustomRow>();
            var limit = Math.Clamp(cq.Limit, 1, 200);
            Read($"SELECT g, {AggSql(false)}, count(*) FROM ({inner}) GROUP BY g ORDER BY 2 DESC NULLS LAST LIMIT {limit}", ct, r =>
                rows.Add(new CustomRow(r.GetString(0), r.IsDBNull(1) ? null : Convert.ToDouble(r.GetValue(1), CultureInfo.InvariantCulture), r.GetInt64(2))));
            return new CustomResult(view, unit, step, null, null, rows, null, rows.Sum(x => x.Count));
        }

        var stepMs = step * 1000L;
        var values = new Dictionary<(long, string), double?>();
        var weight = new Dictionary<string, long>();
        Read($"SELECT (epoch_ms(ts) // {stepMs}) * {stepMs}, g, {AggSql(true)}, count(*) FROM ({inner}) GROUP BY 1, 2", ct, r =>
        {
            var g = r.GetString(1);
            values[(r.GetInt64(0), g)] = r.IsDBNull(2) ? null : Convert.ToDouble(r.GetValue(2), CultureInfo.InvariantCulture);
            weight[g] = weight.GetValueOrDefault(g) + r.GetInt64(3);
        });
        var times = new List<long>();
        for (var t = UnixMs(from) / stepMs * stepMs; t <= UnixMs(to); t += stepMs) times.Add(t);
        var zeroWhenEmpty = agg is "count" or "rate" or "distinct";
        var series = weight.OrderByDescending(kv => kv.Value).Take(Math.Clamp(cq.Limit, 1, 20)).Select(kv => kv.Key)
            .Select(g => new MetricSeries(agg, g, times.Select(t => values.TryGetValue((t, g), out var v) ? v : (zeroWhenEmpty ? 0 : null)).ToList()))
            .ToList();
        return new CustomResult(view, unit, step, times.Select(t => DateTime.UnixEpoch.AddMilliseconds(t)).ToList(), series, null, null, weight.Values.Sum());
    }

    /// <summary>
    /// Champs disponibles pour une source : champs natifs + attributs réellement présents dans les données récentes,
    /// avec leur type (texte ou nombre), pour proposer des choix pertinents dans l'éditeur.
    /// </summary>
    public IReadOnlyList<FieldInfo> Fields(string? sourceName, DateTime from, DateTime to, CancellationToken ct)
    {
        var source = NormalizeSource(sourceName);
        var list = Builtins[source].Select(kv => new FieldInfo(kv.Key, kv.Value.Label, kv.Value.Numeric ? "number" : "text", true, 0)).ToList();

        var (src, where) = CustomSource(source, null, null, from, to);
        var seen = new Dictionary<string, (long Count, bool Numeric)>(StringComparer.Ordinal);
        Read($"SELECT attributes FROM {src} WHERE {string.Join(" AND ", where)} ORDER BY ts DESC LIMIT 3000", ct, r =>
        {
            using var doc = JsonDocument.Parse(r.GetString(0));
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                // Corps / en-têtes HTTP et données internes : trop variés pour servir de regroupement.
                if (p.Name.StartsWith("http.request.header.", StringComparison.Ordinal) || p.Name.StartsWith("http.response.header.", StringComparison.Ordinal)
                    || p.Name is "http.request.body" or "http.response.body" or "{OriginalFormat}" or "vigil.breadcrumbs")
                    continue;
                var numeric = p.Value.ValueKind == JsonValueKind.Number;
                seen[p.Name] = seen.TryGetValue(p.Name, out var s) ? (s.Count + 1, s.Numeric && numeric) : (1, numeric);
            }
        });
        list.AddRange(seen.OrderByDescending(kv => kv.Value.Count).Take(150)
            .Select(kv => new FieldInfo(kv.Key, kv.Key, kv.Value.Numeric ? "number" : "text", false, kv.Value.Count)));
        return list;
    }

    /// <summary>Valeurs les plus fréquentes d'un champ (suggestions de filtre).</summary>
    public IReadOnlyList<FieldValue> FieldValues(string? sourceName, string key, DateTime from, DateTime to, CancellationToken ct)
    {
        var source = NormalizeSource(sourceName);
        var (src, where) = CustomSource(source, null, null, from, to);
        var list = new List<FieldValue>();
        Read($"""
            SELECT CAST({TextExpr(source, key)} AS VARCHAR) AS v, count(*) FROM {src} WHERE {string.Join(" AND ", where)}
            GROUP BY v HAVING v IS NOT NULL ORDER BY 2 DESC LIMIT 25
            """, ct, r => list.Add(new FieldValue(r.GetString(0), r.GetInt64(1))));
        return list;
    }
}
