using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Vigil.Server.Dashboards;

/// <summary>Panneau d'un tableau de bord. Les champs utilisés dépendent de <see cref="Type"/>.</summary>
public sealed class Panel
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Title { get; set; } = "";
    /// <summary>http (séries HTTP), metric, logs (histogramme), logs-table, errors, stat.</summary>
    public string Type { get; set; } = "http";
    /// <summary>Largeur sur 12 colonnes.</summary>
    public int Width { get; set; } = 6;
    /// <summary>s, m ou l.</summary>
    public string Height { get; set; } = "m";

    // Sources
    public string? Service { get; set; }
    public string? Query { get; set; }
    public string? Level { get; set; }
    public string? Metric { get; set; }
    public string? Stat { get; set; }
    public string? GroupBy { get; set; }
    public string? StatusClass { get; set; }
    public bool Outgoing { get; set; }
    /// <summary>Pour un panneau "stat" : http, logs ou errors.</summary>
    public string? Source { get; set; }

    // Panneau "custom" (requête personnalisée)
    /// <summary>logs, spans ou metrics.</summary>
    public string? DataSource { get; set; }
    /// <summary>count, rate, distinct, sum, avg, min, max, p50, p90, p95, p99.</summary>
    public string? Aggregate { get; set; }
    public string? Field { get; set; }
    /// <summary>timeseries, bars, top, table, stat.</summary>
    public string? View { get; set; }
    public int? Limit { get; set; }
}

public sealed class Dashboard
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..10];
    public string Name { get; set; } = "Nouveau tableau de bord";
    public string? Description { get; set; }
    public List<Panel> Panels { get; set; } = [];
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Tableaux de bord enregistrés dans &lt;data&gt;/dashboards.json (écriture atomique).</summary>
public sealed class DashboardStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string _path;
    private readonly Lock _lock = new();
    private List<Dashboard> _dashboards;

    public DashboardStore(IOptions<VigilServerOptions> options, IHostEnvironment env)
    {
        var dir = options.Value.ResolveDataDirectory(env.ContentRootPath);
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "dashboards.json");
        _dashboards = File.Exists(_path)
            ? JsonSerializer.Deserialize<List<Dashboard>>(File.ReadAllText(_path), Json) ?? []
            : Defaults();
        if (!File.Exists(_path)) Save();
    }

    /// <summary>Relit le fichier (après une restauration).</summary>
    public void Reload()
    {
        lock (_lock)
            if (File.Exists(_path)) _dashboards = JsonSerializer.Deserialize<List<Dashboard>>(File.ReadAllText(_path), Json) ?? [];
    }

    public IReadOnlyList<Dashboard> All()
    {
        lock (_lock) return _dashboards.ToList();
    }

    public Dashboard? Get(string id)
    {
        lock (_lock) return _dashboards.FirstOrDefault(d => d.Id == id);
    }

    public Dashboard Upsert(Dashboard dashboard)
    {
        Normalize(dashboard);
        lock (_lock)
        {
            var index = _dashboards.FindIndex(d => d.Id == dashboard.Id);
            if (index >= 0) _dashboards[index] = dashboard;
            else _dashboards.Add(dashboard);
            Save();
        }
        return dashboard;
    }

    public bool Delete(string id)
    {
        lock (_lock)
        {
            var removed = _dashboards.RemoveAll(d => d.Id == id) > 0;
            if (removed) Save();
            return removed;
        }
    }

    private static void Normalize(Dashboard d)
    {
        d.Name = string.IsNullOrWhiteSpace(d.Name) ? "Sans titre" : d.Name.Trim();
        d.UpdatedAt = DateTime.UtcNow;
        foreach (var p in d.Panels)
        {
            if (string.IsNullOrEmpty(p.Id)) p.Id = Guid.NewGuid().ToString("N")[..8];
            p.Width = Math.Clamp(p.Width, 2, 12);
            if (p.Height is not ("s" or "m" or "l")) p.Height = "m";
        }
    }

    private void Save()
    {
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_dashboards, Json));
        File.Move(tmp, _path, overwrite: true);
    }

    /// <summary>Tableaux proposés au premier démarrage (modifiables ou supprimables).</summary>
    private static List<Dashboard> Defaults() =>
    [
        new Dashboard
        {
            Id = "http",
            Name = "Santé HTTP",
            Description = "Débit, erreurs et latence des requêtes reçues, par route.",
            Panels =
            [
                new Panel { Title = "Requêtes / s", Type = "stat", Source = "http", Stat = "rate", Width = 3, Height = "s" },
                new Panel { Title = "Taux d'erreur", Type = "stat", Source = "http", Stat = "errorRate", Width = 3, Height = "s" },
                new Panel { Title = "Latence p95", Type = "stat", Source = "http", Stat = "p95", Width = 3, Height = "s" },
                new Panel { Title = "Erreurs (logs)", Type = "stat", Source = "logs", Level = "error", Width = 3, Height = "s" },
                new Panel { Title = "Requêtes par route", Type = "http", Stat = "rate", GroupBy = "route", Width = 6 },
                new Panel { Title = "Latence p95 par route", Type = "http", Stat = "p95", GroupBy = "route", Width = 6 },
                new Panel { Title = "Réponses par code HTTP", Type = "http", Stat = "rate", GroupBy = "status", Width = 6 },
                new Panel { Title = "Appels sortants (p95)", Type = "http", Stat = "p95", GroupBy = "route", Outgoing = true, Width = 6 },
                new Panel { Title = "Dernières erreurs", Type = "errors", Width = 12 },
            ],
        },
        new Dashboard
        {
            Id = "explorer",
            Name = "Exemples de requêtes personnalisées",
            Description = "Panneaux construits à partir des données : à dupliquer et adapter.",
            Panels =
            [
                new Panel { Title = "Logs par niveau", Type = "custom", DataSource = "logs", Aggregate = "count", GroupBy = "level", View = "bars", Width = 6 },
                new Panel { Title = "Services les plus bavards", Type = "custom", DataSource = "logs", Aggregate = "count", GroupBy = "service", View = "top", Width = 6 },
                new Panel { Title = "Opérations les plus lentes (p95)", Type = "custom", DataSource = "spans", Aggregate = "p95", Field = "duration", GroupBy = "name", View = "top", Width = 6 },
                new Panel { Title = "Messages d'avertissement les plus fréquents", Type = "custom", DataSource = "logs", Query = "level:warn", Aggregate = "count", GroupBy = "template", View = "table", Width = 6 },
                new Panel { Title = "Codes HTTP reçus", Type = "custom", DataSource = "spans", Query = "kind:serveur", Aggregate = "count", GroupBy = "http.response.status_code", View = "timeseries", Width = 12 },
            ],
        },
        new Dashboard
        {
            Id = "runtime",
            Name = "Runtime .NET",
            Description = "Mémoire, GC, threads et exceptions des applications.",
            Panels =
            [
                new Panel { Title = "Mémoire (working set)", Type = "metric", Metric = "dotnet.process.memory.working_set", Width = 6 },
                new Panel { Title = "Collections GC", Type = "metric", Metric = "dotnet.gc.collections", Width = 6 },
                new Panel { Title = "Threads du pool", Type = "metric", Metric = "dotnet.thread_pool.thread.count", Width = 6 },
                new Panel { Title = "Exceptions levées", Type = "metric", Metric = "dotnet.exceptions", Width = 6 },
                new Panel { Title = "Logs par niveau", Type = "logs", Width = 12, Height = "s" },
            ],
        },
    ];
}
