using System.Globalization;
using Vigil.Server.Storage;

namespace Vigil.Server.Query;

public sealed record ProbeStat(string ProbeId, long Checks, double? Uptime, double? AvgMs, double? P95Ms, IReadOnlyList<double?> Buckets);

public sealed record GoodBadPoint(DateTime T, long Total, long Bad);

/// <summary>Requêtes de surveillance : SLO, sondes, détection des nouvelles erreurs.</summary>
public sealed partial class QueryService
{
    private static string BadHttp(double? latencyMs) =>
        latencyMs is > 0 ? $"duration_ns > {(long)(latencyMs.Value * 1_000_000)}" : IsError;

    /// <summary>Événements total / mauvais (erreur, ou plus lent que le seuil) sur les requêtes HTTP entrantes.</summary>
    public (long Total, long Bad) HttpGoodBad(DateTime from, DateTime to, HttpFilter f, double? latencyMs, CancellationToken ct)
    {
        (long, long) result = (0, 0);
        Read($"SELECT count(*), count(*) FILTER (WHERE {BadHttp(latencyMs)}) FROM {HttpSource(from, to, f)}", ct,
            r => result = (r.GetInt64(0), r.GetInt64(1)));
        return result;
    }

    public IReadOnlyList<GoodBadPoint> HttpGoodBadSeries(DateTime from, DateTime to, HttpFilter f, double? latencyMs, int stepSeconds, CancellationToken ct)
    {
        var stepMs = stepSeconds * 1000L;
        var map = new Dictionary<long, (long, long)>();
        Read($"""
            SELECT (epoch_ms(ts) // {stepMs}) * {stepMs}, count(*), count(*) FILTER (WHERE {BadHttp(latencyMs)})
            FROM {HttpSource(from, to, f)} GROUP BY 1
            """, ct, r => map[r.GetInt64(0)] = (r.GetInt64(1), r.GetInt64(2)));
        return Buckets(from, to, stepMs, map);
    }

    private string ProbeSource(DateTime from, DateTime to, string metric)
    {
        var snap = storage.Metrics.Snapshot;
        var source = storage.Metrics.Source(snap, idx => Overlaps(idx, from, to));
        return $"""
            (SELECT ts, value, json_extract_string(attributes, '$."probe.id"') AS probe
             FROM {source} WHERE ts >= {Sql.Ts(from)} AND ts <= {Sql.Ts(to)} AND name = {Sql.Str(metric)})
            """;
    }

    /// <summary>Disponibilité, temps de réponse et barre d'état (un segment par intervalle) de chaque sonde.</summary>
    public IReadOnlyList<ProbeStat> ProbeStats(DateTime from, DateTime to, int buckets, CancellationToken ct)
    {
        buckets = Math.Clamp(buckets, 1, 200);
        var stepMs = Math.Max(1000L, (long)Math.Ceiling((to - from).TotalMilliseconds / buckets));
        var startMs = UnixMs(from);
        var up = new Dictionary<string, (long Checks, double? Uptime)>();
        Read($"SELECT probe, count(*), avg(value) FROM {ProbeSource(from, to, "vigil.probe.up")} WHERE probe IS NOT NULL GROUP BY probe", ct,
            r => up[r.GetString(0)] = (r.GetInt64(1), r.IsDBNull(2) ? null : r.GetDouble(2)));
        var bars = new Dictionary<string, double?[]>();
        Read($"""
            SELECT probe, (epoch_ms(ts) - {startMs}) // {stepMs}, avg(value)
            FROM {ProbeSource(from, to, "vigil.probe.up")} WHERE probe IS NOT NULL GROUP BY 1, 2
            """, ct, r =>
        {
            var probe = r.GetString(0);
            var i = (int)r.GetInt64(1);
            if (!bars.TryGetValue(probe, out var arr)) bars[probe] = arr = new double?[buckets];
            if (i >= 0 && i < buckets) arr[i] = r.IsDBNull(2) ? null : r.GetDouble(2);
        });
        var durations = new Dictionary<string, (double?, double?)>();
        Read($"SELECT probe, avg(value), quantile_cont(value, 0.95) FROM {ProbeSource(from, to, "vigil.probe.duration")} WHERE probe IS NOT NULL GROUP BY probe", ct,
            r => durations[r.GetString(0)] = (r.IsDBNull(1) ? null : r.GetDouble(1), r.IsDBNull(2) ? null : r.GetDouble(2)));

        return up.Select(kv =>
        {
            durations.TryGetValue(kv.Key, out var d);
            return new ProbeStat(kv.Key, kv.Value.Checks, kv.Value.Uptime is { } u ? u * 100 : null, d.Item1, d.Item2,
                bars.TryGetValue(kv.Key, out var b) ? b.Select(v => v is { } x ? x * 100 : (double?)null).ToList() : []);
        }).ToList();
    }

    public (long Total, long Bad) ProbeGoodBad(string probeId, DateTime from, DateTime to, CancellationToken ct)
    {
        (long, long) result = (0, 0);
        Read($"SELECT count(*), count(*) FILTER (WHERE value < 1) FROM {ProbeSource(from, to, "vigil.probe.up")} WHERE probe = {Sql.Str(probeId)}", ct,
            r => result = (r.GetInt64(0), r.GetInt64(1)));
        return result;
    }

    public IReadOnlyList<GoodBadPoint> ProbeGoodBadSeries(string probeId, DateTime from, DateTime to, int stepSeconds, CancellationToken ct)
    {
        var stepMs = stepSeconds * 1000L;
        var map = new Dictionary<long, (long, long)>();
        Read($"""
            SELECT (epoch_ms(ts) // {stepMs}) * {stepMs}, count(*), count(*) FILTER (WHERE value < 1)
            FROM {ProbeSource(from, to, "vigil.probe.up")} WHERE probe = {Sql.Str(probeId)} GROUP BY 1
            """, ct, r => map[r.GetInt64(0)] = (r.GetInt64(1), r.GetInt64(2)));
        return Buckets(from, to, stepMs, map);
    }

    private static List<GoodBadPoint> Buckets(DateTime from, DateTime to, long stepMs, Dictionary<long, (long Total, long Bad)> map)
    {
        var list = new List<GoodBadPoint>();
        for (var t = UnixMs(from) / stepMs * stepMs; t <= UnixMs(to); t += stepMs)
        {
            map.TryGetValue(t, out var v);
            list.Add(new GoodBadPoint(DateTime.UnixEpoch.AddMilliseconds(t), v.Total, v.Bad));
        }
        return list;
    }

    /// <summary>Empreintes d'erreurs déjà vues depuis <paramref name="from"/> (détection des nouvelles erreurs).</summary>
    public HashSet<string> Fingerprints(DateTime from, DateTime to, CancellationToken ct)
    {
        var q = new SearchQuery { ExceptionsOnly = true };
        var snap = storage.Logs.Snapshot;
        var source = storage.Logs.Source(snap, idx => Overlaps(idx, from, to) && q.MayMatch(idx));
        var set = new HashSet<string>(StringComparer.Ordinal);
        Read($"SELECT DISTINCT fingerprint FROM {source} WHERE fingerprint IS NOT NULL AND ts >= {Sql.Ts(from)} AND ts <= {Sql.Ts(to)}", ct,
            r => set.Add(r.GetString(0)));
        return set;
    }

    internal static string Invariant(double v) => v.ToString(CultureInfo.InvariantCulture);
}

public sealed record ExemplarItem(DateTime Ts, double Value, string TraceId, string? SpanId, string Service, string Attributes);

public sealed partial class QueryService
{
    /// <summary>
    /// Exemplars d'une métrique : mesures reliées à leur trace. Triés par valeur décroissante
    /// (les plus lentes ou les plus grosses d'abord), pour aller droit aux traces intéressantes.
    /// </summary>
    public IReadOnlyList<ExemplarItem> MetricExemplars(string name, DateTime from, DateTime to, string? service, int limit, CancellationToken ct)
    {
        var source = storage.Metrics.Source(storage.Metrics.Snapshot, idx => Overlaps(idx, from, to) && (service is null || idx.Services.Contains(service)));
        var where = TimeFilter(from, to);
        where.Add($"name = {Sql.Str(name)}");
        where.Add("exemplars IS NOT NULL");
        if (!string.IsNullOrEmpty(service)) where.Add($"service = {Sql.Str(service)}");
        var list = new List<ExemplarItem>();
        Read($"""
            SELECT e.t, e.v, e.trace, e.span, service, attributes FROM (
              SELECT service, attributes, unnest(from_json(exemplars, '[{"{"}"t":"BIGINT","v":"DOUBLE","trace":"VARCHAR","span":"VARCHAR"{"}"}]')) AS e
              FROM {source} WHERE {string.Join(" AND ", where)})
            WHERE e.t >= {UnixMs(from)} AND e.t <= {UnixMs(to)}
            ORDER BY e.v DESC LIMIT {Math.Clamp(limit, 1, 500)}
            """, ct, r => list.Add(new ExemplarItem(DateTime.UnixEpoch.AddMilliseconds(r.GetInt64(0)), r.GetDouble(1), r.GetString(2),
                r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4), r.GetString(5))));
        return list;
    }
}
