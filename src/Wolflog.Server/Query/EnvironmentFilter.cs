namespace Wolflog.Server.Query;

/// <summary>
/// Environnements configurés (Administration › Environnements), compilés pour les requêtes : à quel environnement se rattache
/// une valeur reçue d'une application, et condition SQL ou test en mémoire (suivi en direct) pour l'environnement choisi.
/// <para>
/// Un environnement configuré regroupe son nom et ses alias, sans tenir compte de la casse. Les alias propres à une application
/// priment pour elle seule : « prod » peut être la production d'une application et la préproduction d'une autre. Toute autre
/// valeur choisie (non configurée, ou lien d'avant la configuration) se compare telle quelle, comme avant.
/// </para>
/// </summary>
public sealed class EnvironmentFilter
{
    /// <summary>Aucune configuration : chaque valeur reçue est un environnement, comparée telle quelle.</summary>
    public static readonly EnvironmentFilter None = new(new EnvironmentSettings());

    private readonly Dictionary<string, EnvironmentDefinition> _byName = new(StringComparer.OrdinalIgnoreCase);
    // Valeur reçue (en minuscules) → nom de l'environnement, pour toutes les applications.
    private readonly Dictionary<string, string> _everywhere = new(StringComparer.Ordinal);
    // Application → valeur reçue (en minuscules) → nom de l'environnement, ou null : valeur gardée telle quelle.
    private readonly Dictionary<string, Dictionary<string, string?>> _apps = new(StringComparer.Ordinal);
    // Application → environnements absents de son sélecteur.
    private readonly Dictionary<string, HashSet<string>> _hidden = new(StringComparer.Ordinal);

    public EnvironmentFilter(EnvironmentSettings settings)
    {
        // Réglages contrôlés à l'enregistrement ; un fichier modifié à la main ne doit pas pour autant casser les requêtes.
        Environments = [.. (settings.Environments ?? []).OfType<EnvironmentDefinition>().Where(e => !string.IsNullOrEmpty(e.Name)).OrderBy(e => e.Order)];
        foreach (var e in Environments) _byName.TryAdd(e.Name, e);
        // Les noms d'abord : un nom désigne toujours son environnement.
        foreach (var e in _byName.Values) _everywhere.TryAdd(Key(e.Name), e.Name);
        foreach (var e in _byName.Values)
            foreach (var alias in (e.Aliases ?? []).Where(a => !string.IsNullOrEmpty(a)))
                _everywhere.TryAdd(Key(alias), e.Name);

        foreach (var app in (settings.Apps ?? []).OfType<AppEnvironments>().Where(a => !string.IsNullOrEmpty(a.Service)))
        {
            var map = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var (raw, target) in app.Aliases ?? [])
            {
                if (string.IsNullOrEmpty(raw)) continue;
                if (string.IsNullOrWhiteSpace(target)) map.TryAdd(Key(raw), null);
                else if (Find(target) is { } environment) map.TryAdd(Key(raw), environment.Name);
            }
            if (map.Count > 0) _apps[app.Service] = map;
            if (app.Hidden is { Count: > 0 } hidden) _hidden[app.Service] = new HashSet<string>(hidden.Where(h => h is not null), StringComparer.OrdinalIgnoreCase);
        }
    }

    /// <summary>Environnements configurés, dans l'ordre du sélecteur.</summary>
    public IReadOnlyList<EnvironmentDefinition> Environments { get; }

    private static string Key(string value) => value.ToLowerInvariant();

    /// <summary>Environnement configuré de ce nom (sans tenir compte de la casse) ; null pour toute autre valeur.</summary>
    public EnvironmentDefinition? Find(string? name) => name is not null && _byName.TryGetValue(name, out var e) ? e : null;

    /// <summary>Environnement configuré auquel se rattache une valeur reçue de cette application ; null : valeur non regroupée.</summary>
    public string? Resolve(string service, string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        var key = Key(raw);
        if (_apps.TryGetValue(service, out var map) && map.TryGetValue(key, out var target)) return target;
        return _everywhere.GetValueOrDefault(key);
    }

    /// <summary>
    /// Condition SQL (colonnes service et env) pour l'environnement choisi. Environnement configuré : les valeurs qui s'y
    /// rattachent, application par application —
    /// <c>(service = 'A' AND lower(env) IN (…)) OR (service NOT IN ('A') AND lower(env) IN (…))</c> —, si bien que les alias
    /// d'une application ne s'appliquent jamais aux autres. Autre valeur : égalité exacte, comme avant toute configuration.
    /// </summary>
    public string Condition(string selected)
    {
        if (Find(selected) is not { } environment) return $"env = {Sql.Str(selected)}";
        var everywhere = ValuesOf(environment.Name);
        var clauses = new List<string>();
        var particular = new List<string>();
        foreach (var (service, map) in _apps.OrderBy(a => a.Key, StringComparer.Ordinal))
        {
            var values = map.Where(kv => kv.Value == environment.Name).Select(kv => kv.Key)
                .Concat(everywhere.Where(v => !map.ContainsKey(v)))
                .Distinct().Order(StringComparer.Ordinal).ToList();
            if (values.SequenceEqual(everywhere)) continue; // ses alias ne touchent pas cet environnement
            particular.Add(service);
            if (values.Count > 0) clauses.Add($"(service = {Sql.Str(service)} AND lower(env) IN {Sql.List(values)})");
        }
        if (everywhere.Count > 0)
            clauses.Add(particular.Count == 0
                ? $"lower(env) IN {Sql.List(everywhere)}"
                : $"(service NOT IN {Sql.List(particular)} AND lower(env) IN {Sql.List(everywhere)})");
        return clauses.Count switch
        {
            0 => "false",
            1 => clauses[0],
            _ => "(" + string.Join(" OR ", clauses) + ")",
        };
    }

    /// <summary>La valeur reçue de cette application appartient-elle à l'environnement choisi ? (même règle que <see cref="Condition"/>)</summary>
    public bool Matches(string selected, string service, string? raw) =>
        Find(selected) is { } environment
            ? Resolve(service, raw) == environment.Name
            : string.Equals(raw, selected, StringComparison.Ordinal);

    /// <summary>Absent du sélecteur : environnement masqué partout, ou masqué pour l'application choisie.</summary>
    public bool IsHidden(string name, string? service) =>
        Find(name)?.Hidden == true || (service is not null && _hidden.TryGetValue(service, out var hidden) && hidden.Contains(name));

    /// <summary>Valeurs (en minuscules, triées) rattachées à cet environnement pour les applications sans alias propres.</summary>
    private List<string> ValuesOf(string name) =>
        [.. _everywhere.Where(kv => kv.Value == name).Select(kv => kv.Key).Order(StringComparer.Ordinal)];
}
