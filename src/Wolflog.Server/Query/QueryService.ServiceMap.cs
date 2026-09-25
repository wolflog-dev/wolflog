namespace Wolflog.Server.Query;

public sealed partial class QueryService
{
    // Cible d'un appel sortant non instrumenté : base de données, file de messages, ou hôte distant.
    private const string ExternalTarget = """
        coalesce(
          json_extract_string(attributes, '$."db.system.name"'), json_extract_string(attributes, '$."db.system"'),
          json_extract_string(attributes, '$."messaging.system"'),
          json_extract_string(attributes, '$."server.address"'), json_extract_string(attributes, '$."net.peer.name"'),
          json_extract_string(attributes, '$."rpc.service"'))
        """;

    private const string ExternalKind = """
        CASE WHEN coalesce(json_extract_string(attributes, '$."db.system.name"'), json_extract_string(attributes, '$."db.system"')) IS NOT NULL THEN 'database'
             WHEN json_extract_string(attributes, '$."messaging.system"') IS NOT NULL OR kind = 4 THEN 'queue'
             ELSE 'external' END
        """;

    private const string ExternalDetail = """
        coalesce(json_extract_string(attributes, '$."db.namespace"'), json_extract_string(attributes, '$."db.name"'),
                 json_extract_string(attributes, '$."server.address"'), json_extract_string(attributes, '$."messaging.destination.name"'))
        """;

    /// <summary>
    /// Carte des services : appels entre services (span client → span serveur d'un autre service, même trace)
    /// et dépendances externes (appels sortants sans service instrumenté en face).
    /// </summary>
    public ServiceMap ServiceMap(DateTime from, DateTime to, CancellationToken ct)
    {
        var source = storage.Spans.Source(storage.Spans.Snapshot, idx => Overlaps(idx, from, to));
        var where = string.Join(" AND ", TimeFilter(from, to));
        var spans = $"(SELECT ts, duration_ns, trace_id, span_id, parent_span_id, service, kind, status_code, attributes FROM {source} WHERE {where})";

        var nodes = new Dictionary<string, MapNode>();
        Read($"""
            SELECT service, count(*) FILTER (WHERE kind = 2), count(*) FILTER (WHERE kind = 2 AND status_code = 2),
                   quantile_cont(duration_ns, 0.95) FILTER (WHERE kind = 2)
            FROM {spans} GROUP BY service
            """, ct, r => nodes[r.GetString(0)] = new MapNode(r.GetString(0), r.GetString(0), "service", r.GetInt64(1), r.GetInt64(2),
                r.IsDBNull(3) ? null : r.GetDouble(3) / 1e6, null));

        var edges = new List<MapEdge>();
        // Appels entre services : l'enfant (côté appelé) est dans un autre service que son parent.
        Read($"""
            WITH s AS {spans}
            SELECT p.service, c.service, count(*), count(*) FILTER (WHERE c.status_code = 2), quantile_cont(c.duration_ns, 0.95)
            FROM s c JOIN s p ON c.trace_id = p.trace_id AND c.parent_span_id = p.span_id
            WHERE c.service <> p.service
            GROUP BY 1, 2
            """, ct, r => edges.Add(new MapEdge(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3), r.IsDBNull(4) ? null : r.GetDouble(4) / 1e6)));

        // Dépendances externes : appel sortant (client ou producteur) sans span enfant instrumenté.
        Read($"""
            WITH s AS {spans},
            calls AS (
              SELECT trace_id, span_id, service, status_code, duration_ns,
                     {ExternalTarget} AS target, {ExternalKind} AS type, {ExternalDetail} AS detail
              FROM s WHERE kind IN (3, 4)),
            out AS (
              SELECT c.* FROM calls c LEFT JOIN s x ON x.trace_id = c.trace_id AND x.parent_span_id = c.span_id
              WHERE x.span_id IS NULL)
            SELECT service, target, any_value(type), any_value(detail), count(*), count(*) FILTER (WHERE status_code = 2), quantile_cont(duration_ns, 0.95)
            FROM out WHERE target IS NOT NULL GROUP BY 1, 2
            """, ct, r =>
        {
            var target = r.GetString(1);
            var type = r.GetString(2);
            var id = $"{type}:{target}";
            // Un hôte qui est en réalité un service instrumenté (appel non relié à sa trace) reste un service.
            if (nodes.ContainsKey(target)) id = target;
            else if (!nodes.TryGetValue(id, out var existing))
                nodes[id] = new MapNode(id, target, type, 0, 0, null, r.IsDBNull(3) ? null : r.GetString(3));
            var calls = r.GetInt64(4);
            var errors = r.GetInt64(5);
            if (id != target)
            {
                var n = nodes[id];
                nodes[id] = n with { Requests = n.Requests + calls, Errors = n.Errors + errors };
            }
            edges.Add(new MapEdge(r.GetString(0), id, calls, errors, r.IsDBNull(6) ? null : r.GetDouble(6) / 1e6));
        });

        // Regroupe les arêtes identiques (service appelé à la fois relié et non relié).
        var merged = edges.GroupBy(e => (e.Source, e.Target)).Select(g => new MapEdge(g.Key.Source, g.Key.Target,
            g.Sum(e => e.Calls), g.Sum(e => e.Errors), g.Max(e => e.P95Ms))).Where(e => e.Source != e.Target).ToList();
        return new ServiceMap(nodes.Values.OrderBy(n => n.Kind != "service").ThenBy(n => n.Name).ToList(), merged, Math.Max(1, (to - from).TotalSeconds));
    }
}
