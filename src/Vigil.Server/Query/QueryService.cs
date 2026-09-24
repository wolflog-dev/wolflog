using System.Data.Common;
using System.Diagnostics;
using System.Text.Json;
using Vigil.Server.Storage;

namespace Vigil.Server.Query;

/// <summary>Toutes les requêtes de lecture (API de l'interface).</summary>
public sealed class QueryService(StorageHost storage)
{
    private const string LogColumns =
        "ts, service, host, env, version, severity, body, trace_id, span_id, category, exception_type, exception_message, exception_stack, fingerprint, is_crash, attributes, resource";

    // ------------------------------------------------------------------ logs

    public LogPage SearchLogs(DateTime from, DateTime to, SearchQuery q, int limit, DateTime? before, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        limit = Math.Clamp(limit, 1, 5000);
        var upper = before is { } b && b < to ? b : to;
        var snap = storage.Logs.Snapshot;
        var scanned = 0;
        var source = storage.Logs.Source(snap, idx =>
        {
            var keep = Overlaps(idx, from, upper) && q.MayMatch(idx);
            if (keep) scanned++;
            return keep;
        });

        var where = TimeFilter(from, upper, inclusiveEnd: before is null);
        q.AppendLogFilters(where);
        var sql = $"SELECT {LogColumns} FROM {source} WHERE {string.Join(" AND ", where)} ORDER BY ts DESC LIMIT {limit}";

        var items = new List<LogItem>(Math.Min(limit, 1024));
        Read(sql, ct, r => items.Add(ReadLog(r)));
        var next = items.Count == limit ? items[^1].Ts : (DateTime?)null;
        return new LogPage(items, next, sw.ElapsedMilliseconds, scanned, snap.Segments.Length);
    }

    public Histogram LogHistogram(DateTime from, DateTime to, SearchQuery q, CancellationToken ct)
    {
        var step = StepFor(from, to, 80);
        var snap = storage.Logs.Snapshot;
        var source = storage.Logs.Source(snap, idx => Overlaps(idx, from, to) && q.MayMatch(idx));
        var where = TimeFilter(from, to);
        q.AppendLogFilters(where);
        return HistogramQuery(source, where, from, to, step, ct);
    }

    private Histogram HistogramQuery(string source, List<string> where, DateTime from, DateTime to, int step, CancellationToken ct)
    {
        var stepMs = step * 1000L;
        var sql = $"""
            SELECT (epoch_ms(ts) // {stepMs}) * {stepMs} AS b,
                   count(*) FILTER (WHERE severity BETWEEN 1 AND 4),
                   count(*) FILTER (WHERE severity BETWEEN 5 AND 8),
                   count(*) FILTER (WHERE severity = 0 OR severity BETWEEN 9 AND 12),
                   count(*) FILTER (WHERE severity BETWEEN 13 AND 16),
                   count(*) FILTER (WHERE severity BETWEEN 17 AND 20),
                   count(*) FILTER (WHERE severity >= 21)
            FROM {source} WHERE {string.Join(" AND ", where)}
            GROUP BY b ORDER BY b
            """;
        var map = new Dictionary<long, HistogramBucket>();
        Read(sql, ct, r =>
        {
            var t = r.GetInt64(0);
            map[t] = new HistogramBucket(DateTime.UnixEpoch.AddMilliseconds(t), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4), r.GetInt64(5), r.GetInt64(6));
        });

        // Série complète (buckets vides inclus) : l'interface n'a pas à combler les trous.
        var buckets = new List<HistogramBucket>();
        var start = UnixMs(from) / stepMs * stepMs;
        var end = UnixMs(to);
        for (var t = start; t <= end; t += stepMs)
            buckets.Add(map.TryGetValue(t, out var hb) ? hb : new HistogramBucket(DateTime.UnixEpoch.AddMilliseconds(t), 0, 0, 0, 0, 0, 0));
        return new Histogram(step, buckets);
    }

    // ------------------------------------------------------------------ traces

    public IReadOnlyList<TraceSummary> SearchTraces(DateTime from, DateTime to, string? service, string? text, double? minDurationMs, bool errorsOnly, int limit, CancellationToken ct)
    {
        limit = Math.Clamp(limit, 1, 1000);
        var snap = storage.Spans.Snapshot;
        var source = storage.Spans.Source(snap, idx => Overlaps(idx, from, to) && (!errorsOnly || idx.HasExceptions));
        var having = new List<string> { "true" };
        if (!string.IsNullOrEmpty(service)) having.Add($"bool_or(service = {Sql.Str(service)})");
        if (!string.IsNullOrWhiteSpace(text)) having.Add($"bool_or(name ILIKE {Sql.Like(text.Trim())} ESCAPE '\\')");
        if (minDurationMs is > 0) having.Add($"max(epoch_ns(ts) + duration_ns) - min(epoch_ns(ts)) >= {(long)(minDurationMs.Value * 1_000_000)}");
        if (errorsOnly) having.Add("count(*) FILTER (WHERE status_code = 2) > 0");

        var sql = $"""
            SELECT trace_id, min(ts), max(epoch_ns(ts) + duration_ns) - min(epoch_ns(ts)), count(*),
                   arg_min(name, rk), arg_min(service, rk), count(DISTINCT service), count(*) FILTER (WHERE status_code = 2)
            FROM (SELECT trace_id, ts, duration_ns, name, service, status_code,
                         epoch_ns(ts) + CASE WHEN parent_span_id IS NULL THEN 0 ELSE 4611686018427387904 END AS rk
                  FROM {source} WHERE {string.Join(" AND ", TimeFilter(from, to))})
            GROUP BY trace_id
            HAVING {string.Join(" AND ", having)}
            ORDER BY min(ts) DESC
            LIMIT {limit}
            """;
        var list = new List<TraceSummary>();
        Read(sql, ct, r => list.Add(new TraceSummary(
            r.GetString(0), Utc(r.GetDateTime(1)), r.GetInt64(2) / 1_000_000.0, (int)r.GetInt64(3),
            r.GetString(4), r.GetString(5), (int)r.GetInt64(6), (int)r.GetInt64(7))));
        return list;
    }

    public TraceDetail GetTrace(string traceId, DateTime? around, CancellationToken ct)
    {
        traceId = traceId.ToLowerInvariant();
        DateTime from = DateTime.MinValue, to = DateTime.MaxValue;
        if (around is { } a) { from = a.AddHours(-2); to = a.AddHours(2); }

        var spanSnap = storage.Spans.Snapshot;
        var spanSource = storage.Spans.Source(spanSnap, idx => Overlaps(idx, from, to) && idx.TraceIds.MayContain(traceId));
        var spans = new List<SpanItem>();
        Read($"""
            SELECT ts, duration_ns, trace_id, span_id, parent_span_id, service, host, name, kind, status_code, status_message, scope, attributes, events, resource
            FROM {spanSource} WHERE trace_id = {Sql.Str(traceId)} ORDER BY ts LIMIT 20000
            """, ct, r => spans.Add(new SpanItem(
            Utc(r.GetDateTime(0)), r.GetInt64(1) / 1_000_000.0, r.GetString(2), r.GetString(3), Str(r, 4), r.GetString(5), Str(r, 6),
            r.GetString(7), r.GetByte(8), r.GetByte(9), Str(r, 10), Str(r, 11), r.GetString(12), r.GetString(13), r.GetString(14))));

        var q = new SearchQuery { TraceId = traceId };
        var logSnap = storage.Logs.Snapshot;
        var logSource = storage.Logs.Source(logSnap, idx => Overlaps(idx, from, to) && q.MayMatch(idx));
        var logs = new List<LogItem>();
        Read($"SELECT {LogColumns} FROM {logSource} WHERE trace_id = {Sql.Str(traceId)} ORDER BY ts LIMIT 5000", ct, r => logs.Add(ReadLog(r)));
        return new TraceDetail(traceId, spans, logs);
    }

    // ------------------------------------------------------------------ erreurs

    public IReadOnlyList<ErrorGroup> Errors(DateTime from, DateTime to, SearchQuery q, int limit, CancellationToken ct)
    {
        q.ExceptionsOnly = true;
        var snap = storage.Logs.Snapshot;
        var source = storage.Logs.Source(snap, idx => Overlaps(idx, from, to) && q.MayMatch(idx));
        var where = TimeFilter(from, to);
        q.AppendLogFilters(where);
        var sql = $"""
            SELECT fingerprint, any_value(exception_type), arg_max(exception_message, ts), arg_max(service, ts), count(*),
                   count(*) FILTER (WHERE is_crash), min(ts), max(ts), count(DISTINCT service)
            FROM {source} WHERE {string.Join(" AND ", where)}
            GROUP BY fingerprint ORDER BY max(ts) DESC LIMIT {Math.Clamp(limit, 1, 1000)}
            """;
        var list = new List<ErrorGroup>();
        Read(sql, ct, r => list.Add(ReadErrorGroup(r)));
        return list;
    }

    private static ErrorGroup ReadErrorGroup(DbDataReader r) => new(
        r.GetString(0), Str(r, 1) ?? "Exception", Str(r, 2), r.GetString(3), r.GetInt64(4), r.GetInt64(5),
        Utc(r.GetDateTime(6)), Utc(r.GetDateTime(7)), (int)r.GetInt64(8));

    public ErrorDetail? ErrorDetail(string fingerprint, DateTime from, DateTime to, CancellationToken ct)
    {
        var q = new SearchQuery { Fingerprint = fingerprint };
        var group = Errors(from, to, q, 1, ct).FirstOrDefault();
        if (group is null) return null;

        var snap = storage.Logs.Snapshot;
        var source = storage.Logs.Source(snap, idx => Overlaps(idx, from, to) && q.MayMatch(idx));
        var where = TimeFilter(from, to);
        q.AppendLogFilters(where);
        var filter = string.Join(" AND ", where);

        LogItem? latest = null;
        Read($"SELECT {LogColumns} FROM {source} WHERE {filter} ORDER BY ts DESC LIMIT 1", ct, r => latest = ReadLog(r));

        var occurrences = new List<ErrorOccurrence>();
        Read($"SELECT ts, service, host, version, trace_id, is_crash, exception_message FROM {source} WHERE {filter} ORDER BY ts DESC LIMIT 200", ct,
            r => occurrences.Add(new ErrorOccurrence(Utc(r.GetDateTime(0)), r.GetString(1), Str(r, 2), Str(r, 3), Str(r, 4), r.GetBoolean(5), Str(r, 6))));

        var histogram = HistogramQuery(source, where, from, to, StepFor(from, to, 60), ct);
        return new ErrorDetail(group, latest, occurrences, histogram);
    }

    // ------------------------------------------------------------------ métriques

    public IReadOnlyList<MetricInfo> MetricNames(DateTime from, DateTime to, string? service, CancellationToken ct)
    {
        var snap = storage.Metrics.Snapshot;
        var source = storage.Metrics.Source(snap, idx => Overlaps(idx, from, to) && (service is null || idx.Services.Contains(service)));
        var where = TimeFilter(from, to);
        if (!string.IsNullOrEmpty(service)) where.Add($"service = {Sql.Str(service)}");
        var list = new List<MetricInfo>();
        Read($"""
            SELECT name, any_value(type), any_value(unit), any_value(description), count(*)
            FROM {source} WHERE {string.Join(" AND ", where)} GROUP BY name ORDER BY name
            """, ct, r => list.Add(new MetricInfo(r.GetString(0), r.GetByte(1), Str(r, 2), Str(r, 3), r.GetInt64(4))));
        return list;
    }

    public IReadOnlyList<string> MetricAttributeKeys(string name, DateTime from, DateTime to, CancellationToken ct)
    {
        var snap = storage.Metrics.Snapshot;
        var source = storage.Metrics.Source(snap, idx => Overlaps(idx, from, to));
        var where = TimeFilter(from, to);
        where.Add($"name = {Sql.Str(name)}");
        var keys = new List<string>();
        Read($"SELECT DISTINCT unnest(json_keys(attributes)) AS k FROM {source} WHERE {string.Join(" AND ", where)} ORDER BY k LIMIT 100", ct,
            r => keys.Add(r.GetString(0)));
        return keys;
    }

    public MetricData MetricSeries(string name, DateTime from, DateTime to, string? service, string? groupBy, string? stat, CancellationToken ct)
    {
        var step = StepFor(from, to, 120, minimum: 10);
        var stepMs = step * 1000L;
        var snap = storage.Metrics.Snapshot;
        var source = storage.Metrics.Source(snap, idx => Overlaps(idx, from, to) && (service is null || idx.Services.Contains(service)));
        var where = TimeFilter(from, to);
        where.Add($"name = {Sql.Str(name)}");
        if (!string.IsNullOrEmpty(service)) where.Add($"service = {Sql.Str(service)}");
        var filter = string.Join(" AND ", where);

        // Type de la métrique
        byte type = 1, temporality = 0;
        bool monotonic = false;
        string? unit = null;
        Read($"SELECT any_value(type), any_value(temporality), any_value(monotonic), any_value(unit) FROM {source} WHERE {filter}", ct, r =>
        {
            if (r.IsDBNull(0)) return;
            type = r.GetByte(0);
            temporality = r.GetByte(1);
            monotonic = r.GetBoolean(2);
            unit = Str(r, 3);
        });

        var group = groupBy switch
        {
            null or "" or "service" => "service",
            "none" => "'total'",
            _ => $"coalesce(json_extract_string(attributes, {Sql.Str("$.\"" + groupBy.Replace("\"", "") + "\"")}), '(vide)')",
        };

        var isHistogram = type is 3 or 4;
        stat = (stat ?? "").ToLowerInvariant();
        if (isHistogram && stat is not ("avg" or "count" or "max" or "p50" or "p95" or "p99")) stat = "p95";
        if (!isHistogram) stat = type == 2 && monotonic ? (temporality == 1 ? "rate" : "last") : (type == 2 ? "sum" : "avg");

        var values = new Dictionary<(long, string), double?>();
        if (isHistogram && stat.StartsWith('p'))
        {
            var quantile = double.Parse(stat[1..], System.Globalization.CultureInfo.InvariantCulture) / 100.0;
            var merged = new Dictionary<(long, string), (double[] Bounds, long[] Counts)>();
            Read($"SELECT (epoch_ms(ts) // {stepMs}) * {stepMs}, {group}, buckets FROM {source} WHERE {filter} AND buckets IS NOT NULL", ct, r =>
            {
                var key = (r.GetInt64(0), r.GetString(1));
                using var doc = JsonDocument.Parse(r.GetString(2));
                var bounds = doc.RootElement.GetProperty("bounds").EnumerateArray().Select(e => e.GetDouble()).ToArray();
                var counts = doc.RootElement.GetProperty("counts").EnumerateArray().Select(e => e.GetInt64()).ToArray();
                if (merged.TryGetValue(key, out var m) && m.Counts.Length == counts.Length)
                    for (var i = 0; i < counts.Length; i++) m.Counts[i] += counts[i];
                else
                    merged[key] = (bounds, counts);
            });
            foreach (var (key, m) in merged) values[key] = Quantile(m.Bounds, m.Counts, quantile);
        }
        else
        {
            var agg = stat switch
            {
                "rate" => $"sum(value) / {step}.0",
                "last" => "max(value)",
                "sum" => "sum(value)",
                "count" => $"sum(count) / {step}.0",
                "max" => "max(max)",
                _ when isHistogram => "sum(sum) / nullif(sum(count), 0)",
                _ => "avg(value)",
            };
            Read($"SELECT (epoch_ms(ts) // {stepMs}) * {stepMs}, {group}, {agg} FROM {source} WHERE {filter} GROUP BY 1, 2", ct,
                r => values[(r.GetInt64(0), r.GetString(1))] = r.IsDBNull(2) ? null : r.GetDouble(2));
        }

        var start = UnixMs(from) / stepMs * stepMs;
        var end = UnixMs(to);
        var times = new List<long>();
        for (var t = start; t <= end; t += stepMs) times.Add(t);

        var series = values.Keys.Select(k => k.Item2).Distinct().Order().Take(50)
            .Select(g => new MetricSeries(name, g, times.Select(t => values.TryGetValue((t, g), out var v) ? v : null).ToList()))
            .ToList();
        var displayUnit = stat is "rate" or "count" ? "/s" : unit;
        return new MetricData(name, stat, displayUnit, step, times.Select(t => DateTime.UnixEpoch.AddMilliseconds(t)).ToList(), series);
    }

    /// <summary>Quantile estimé à partir d'un histogramme à bornes explicites (interpolation linéaire).</summary>
    public static double? Quantile(double[] bounds, long[] counts, double q)
    {
        var total = counts.Sum();
        if (total == 0) return null;
        var rank = q * total;
        long cumulative = 0;
        for (var i = 0; i < counts.Length; i++)
        {
            if (counts[i] == 0) { continue; }
            if (cumulative + counts[i] >= rank)
            {
                var lower = i == 0 ? 0 : bounds[i - 1];
                var upper = i < bounds.Length ? bounds[i] : (bounds.Length > 0 ? bounds[^1] : 0);
                if (i >= bounds.Length) return upper;
                var fraction = (rank - cumulative) / counts[i];
                return lower + (upper - lower) * fraction;
            }
            cumulative += counts[i];
        }
        return bounds.Length > 0 ? bounds[^1] : null;
    }

    // ------------------------------------------------------------------ vue d'ensemble

    public IReadOnlyList<ServiceInfo> Services(DateTime from, DateTime to, CancellationToken ct)
    {
        var map = new Dictionary<string, ServiceInfo>();
        var logSource = storage.Logs.Source(storage.Logs.Snapshot, idx => Overlaps(idx, from, to));
        Read($"""
            SELECT service, count(*), count(*) FILTER (WHERE severity >= 17), max(ts)
            FROM {logSource} WHERE {string.Join(" AND ", TimeFilter(from, to))} GROUP BY service
            """, ct, r => map[r.GetString(0)] = new ServiceInfo(r.GetString(0), r.GetInt64(1), r.GetInt64(2), 0, 0, null, Utc(r.GetDateTime(3))));

        var spanSource = storage.Spans.Source(storage.Spans.Snapshot, idx => Overlaps(idx, from, to));
        Read($"""
            SELECT service, count(*), count(*) FILTER (WHERE status_code = 2),
                   quantile_cont(duration_ns, 0.95) FILTER (WHERE kind = 2), max(ts)
            FROM {spanSource} WHERE {string.Join(" AND ", TimeFilter(from, to))} GROUP BY service
            """, ct, r =>
        {
            var name = r.GetString(0);
            double? p95 = r.IsDBNull(3) ? null : r.GetDouble(3) / 1_000_000.0;
            var last = Utc(r.GetDateTime(4));
            map[name] = map.TryGetValue(name, out var s)
                ? s with { Spans = r.GetInt64(1), SpanErrors = r.GetInt64(2), P95Ms = p95, LastSeen = s.LastSeen > last ? s.LastSeen : last }
                : new ServiceInfo(name, 0, 0, r.GetInt64(1), r.GetInt64(2), p95, last);
        });
        return map.Values.OrderBy(s => s.Name).ToList();
    }

    public Overview Overview(DateTime from, DateTime to, CancellationToken ct)
    {
        var services = Services(from, to, ct);
        long crashes = 0, traces = 0;
        double? p95 = null;

        var logSource = storage.Logs.Source(storage.Logs.Snapshot, idx => Overlaps(idx, from, to) && idx.HasExceptions);
        Read($"SELECT count(*) FROM {logSource} WHERE {string.Join(" AND ", TimeFilter(from, to))} AND is_crash", ct, r => crashes = r.GetInt64(0));

        var spanSource = storage.Spans.Source(storage.Spans.Snapshot, idx => Overlaps(idx, from, to));
        Read($"""
            SELECT approx_count_distinct(trace_id), quantile_cont(duration_ns, 0.95) FILTER (WHERE kind = 2)
            FROM {spanSource} WHERE {string.Join(" AND ", TimeFilter(from, to))}
            """, ct, r =>
        {
            traces = r.GetInt64(0);
            p95 = r.IsDBNull(1) ? null : r.GetDouble(1) / 1_000_000.0;
        });

        var histogram = LogHistogram(from, to, new SearchQuery(), ct);
        var topErrors = Errors(from, to, new SearchQuery(), 8, ct);
        return new Overview(
            services.Sum(s => s.Logs), services.Sum(s => s.Errors), crashes, services.Sum(s => s.Spans), traces, p95,
            histogram, services, topErrors);
    }

    public SystemStats Stats()
    {
        var stores = storage.All.Select(s =>
        {
            var snap = s.Snapshot;
            return new StoreStats(s.Name, s.IngestedRows, s.HotRows, snap.Segments.Length, snap.Segments.Sum(x => x.SizeBytes),
                snap.Segments.Length > 0 ? snap.Segments.Min(x => x.Index.MinTs) : null);
        }).ToList();
        return new SystemStats(storage.StartedAt, storage.DataDirectory, storage.DiskBytes(),
            Process.GetCurrentProcess().WorkingSet64, storage.Tail.Count, stores,
            typeof(QueryService).Assembly.GetName().Version?.ToString(3) ?? "0.0.0");
    }

    // ------------------------------------------------------------------ utilitaires

    private static long UnixMs(DateTime t) => (long)(DateTime.SpecifyKind(t, DateTimeKind.Utc) - DateTime.UnixEpoch).TotalMilliseconds;

    private static bool Overlaps(SegmentIndex idx, DateTime from, DateTime to) => idx.MaxTs >= from && idx.MinTs <= to;

    private static List<string> TimeFilter(DateTime from, DateTime to, bool inclusiveEnd = true)
    {
        var list = new List<string>();
        if (from > DateTime.MinValue) list.Add($"ts >= {Sql.Ts(from)}");
        if (to < DateTime.MaxValue) list.Add(inclusiveEnd ? $"ts <= {Sql.Ts(to)}" : $"ts < {Sql.Ts(to)}");
        if (list.Count == 0) list.Add("true");
        return list;
    }

    /// <summary>Pas "rond" (en secondes) pour découper l'intervalle en ~<paramref name="target"/> tranches.</summary>
    public static int StepFor(DateTime from, DateTime to, int target, int minimum = 1)
    {
        int[] steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
        var seconds = Math.Max(1, (to - from).TotalSeconds);
        var ideal = seconds / target;
        foreach (var s in steps)
            if (s >= ideal && s >= minimum) return s;
        return steps[^1];
    }

    private static LogItem ReadLog(DbDataReader r)
    {
        var severity = r.GetByte(5);
        return new LogItem(
            Utc(r.GetDateTime(0)), r.GetString(1), Str(r, 2), Str(r, 3), Str(r, 4), severity, SearchQuery.SeverityToLevel(severity),
            r.GetString(6), Str(r, 7), Str(r, 8), Str(r, 9), Str(r, 10), Str(r, 11), Str(r, 12), Str(r, 13), r.GetBoolean(14),
            r.GetString(15), r.GetString(16));
    }

    private static string? Str(DbDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);

    private static DateTime Utc(DateTime t) => DateTime.SpecifyKind(t, DateTimeKind.Utc);

    private void Read(string sql, CancellationToken ct, Action<DbDataReader> row)
    {
        using var conn = storage.Engine.Connect();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        using var reg = ct.Register(() => { try { cmd.Cancel(); } catch { /* requête déjà terminée */ } });
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            ct.ThrowIfCancellationRequested();
            row(reader);
        }
    }
}
