namespace Wolflog.Server.Query;

/// <summary>
/// Environnements : ceux configurés (valeurs reçues regroupées application par application, voir <see cref="EnvironmentFilter"/>)
/// et les valeurs reçues telles quelles, pour le sélecteur de la barre du haut et la page Administration › Environnements.
/// </summary>
public sealed partial class QueryService
{
    private readonly EnvironmentStore? _environments;
    private EnvironmentFilter? _envFilter;

    /// <summary>Instance de l'API (injection de dépendances) : les environnements configurés traduisent <see cref="Env"/>.</summary>
    public QueryService(StorageHost host, EnvironmentStore environments) : this(host) => _environments = environments;

    /// <summary>
    /// Règles qui traduisent <see cref="Env"/> en condition : environnement configuré → valeurs regroupées, application par
    /// application ; autre valeur → comparée telle quelle. Lues à la première utilisation (aucune configuration : telles quelles).
    /// </summary>
    public EnvironmentFilter EnvFilter
    {
        get => _envFilter ??= _environments?.Filter ?? EnvironmentFilter.None;
        set => _envFilter = value;
    }

    /// <summary>Noms des environnements des 7 derniers jours (valeurs de ?env=), dans l'ordre du sélecteur. Voir <see cref="EnvironmentStats"/>.</summary>
    public IReadOnlyList<string> Environments(string? service, CancellationToken ct) => [.. EnvironmentStats(service, ct).Select(e => e.Name)];

    /// <summary>
    /// Environnements des 7 derniers jours avec leur activité, pour le sélecteur de la barre du haut : environnements configurés
    /// (dans leur ordre), puis valeurs non regroupées (par ordre alphabétique), sans ceux qui sont masqués.
    /// <paramref name="service"/> : seulement ceux où cette application a envoyé des données, sans ceux qu'elle masque.
    /// L'environnement choisi (<see cref="Env"/>) ne compte pas.
    /// </summary>
    public IReadOnlyList<EnvironmentInfo> EnvironmentStats(string? service, CancellationToken ct)
    {
        var filter = EnvFilter;
        var groups = new Dictionary<string, EnvironmentGroup>(StringComparer.OrdinalIgnoreCase);
        foreach (var usage in ReceivedEnvironments(DateTime.UtcNow.AddDays(-7), service, ct))
        {
            var name = filter.Resolve(usage.Service, usage.Env) ?? usage.Env;
            if (!groups.TryGetValue(name, out var group)) groups[name] = group = new EnvironmentGroup(name, filter.Find(name));
            group.Add(usage);
        }
        return [.. groups.Values
            .Where(g => !filter.IsHidden(g.Name, service))
            .OrderBy(g => g.Definition is null).ThenBy(g => g.Definition?.Order ?? 0).ThenBy(g => g.Name, StringComparer.OrdinalIgnoreCase)
            .Select((g, i) => g.ToInfo(i))];
    }

    /// <summary>
    /// Valeurs d'environnement reçues depuis <paramref name="from"/>, par application (logs et spans), triées par application
    /// puis par valeur. L'environnement choisi (<see cref="Env"/>) ne compte pas ; les services visibles du compte, si.
    /// </summary>
    public IReadOnlyList<EnvironmentUsage> ReceivedEnvironments(DateTime from, string? service, CancellationToken ct)
    {
        var selected = Env;
        List<string> where;
        Env = null;
        try { where = TimeFilter(from, DateTime.MaxValue); }
        finally { Env = selected; }
        where.Add("env IS NOT NULL");
        if (!string.IsNullOrEmpty(service)) where.Add($"service = {Sql.Str(service)}");
        var condition = string.Join(" AND ", where);
        bool Keep(SegmentIndex idx) => idx.MaxTs >= from && (string.IsNullOrEmpty(service) || idx.Services.Contains(service));

        var map = new Dictionary<(string Service, string Env), EnvironmentUsage>();
        void Add(string svc, string env, long logs, long errors, long spans, DateTime last)
        {
            var u = map.TryGetValue((svc, env), out var known) ? known : new EnvironmentUsage(svc, env, 0, 0, 0, null);
            map[(svc, env)] = u with { Logs = u.Logs + logs, Errors = u.Errors + errors, Spans = u.Spans + spans, LastSeen = u.LastSeen > last ? u.LastSeen : last };
        }
        Read($"""
            SELECT service, env, count(*), count(*) FILTER (WHERE severity >= 17), max(ts)
            FROM {storage.Logs.Source(storage.Logs.Snapshot, Keep)} WHERE {condition} GROUP BY service, env
            """, ct, r => Add(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetInt64(3), 0, Utc(r.GetDateTime(4))));
        Read($"""
            SELECT service, env, count(*), max(ts)
            FROM {storage.Spans.Source(storage.Spans.Snapshot, Keep)} WHERE {condition} GROUP BY service, env
            """, ct, r => Add(r.GetString(0), r.GetString(1), 0, 0, r.GetInt64(2), Utc(r.GetDateTime(3))));
        return [.. map.Values.OrderBy(u => u.Service, StringComparer.Ordinal).ThenBy(u => u.Env, StringComparer.Ordinal)];
    }

    /// <summary>Activité cumulée d'un environnement du sélecteur (configuré, ou valeur non regroupée).</summary>
    private sealed class EnvironmentGroup(string name, EnvironmentDefinition? definition)
    {
        // Application → valeurs reçues d'elle.
        private readonly SortedDictionary<string, SortedSet<string>> _apps = new(StringComparer.Ordinal);
        private long _logs, _errors, _spans;
        private DateTime? _last;

        public string Name => name;
        public EnvironmentDefinition? Definition => definition;

        public void Add(EnvironmentUsage u)
        {
            _logs += u.Logs;
            _errors += u.Errors;
            _spans += u.Spans;
            if (u.LastSeen > _last || _last is null) _last = u.LastSeen;
            if (!_apps.TryGetValue(u.Service, out var raw)) _apps[u.Service] = raw = new SortedSet<string>(StringComparer.Ordinal);
            raw.Add(u.Env);
        }

        public EnvironmentInfo ToInfo(int order)
        {
            var kind = definition?.Kind ?? EnvironmentKinds.Guess(name);
            return new EnvironmentInfo(name, _logs, _errors, _spans, _apps.Count, _last)
            {
                Label = definition?.Label ?? name, Kind = kind, Tone = EnvironmentKinds.Tone(kind), Color = definition?.Color,
                Order = order, Configured = definition is not null,
                Raw = [.. _apps.Values.SelectMany(v => v).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)],
                Apps = [.. _apps.Select(a => new EnvironmentApp(a.Key, [.. a.Value]))],
            };
        }
    }
}
