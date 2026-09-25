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

/// <summary>
/// Variable de tableau de bord : une liste de valeurs (ex. les routes) choisie dans l'en-tête,
/// réutilisée dans les panneaux par $nom (filtre, service, regroupement, titre).
/// </summary>
public sealed class DashboardVariable
{
    public string Name { get; set; } = "";
    public string? Label { get; set; }
    /// <summary>Champ dont on propose les valeurs (service, env, host, http.route, attribut…).</summary>
    public string Field { get; set; } = "service";
    /// <summary>logs, spans ou metrics : où chercher les valeurs.</summary>
    public string Source { get; set; } = "spans";
    public string? Default { get; set; }
}

public sealed class Dashboard
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..10];
    public string Name { get; set; } = "Nouveau tableau de bord";
    public string? Description { get; set; }
    public List<Panel> Panels { get; set; } = [];
    public List<DashboardVariable> Variables { get; set; } = [];
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
        var exists = File.Exists(_path);
        _dashboards = exists ? JsonSerializer.Deserialize<List<Dashboard>>(File.ReadAllText(_path), Json) ?? [] : Defaults();
        // Tableaux par défaut ajoutés dans une version plus récente : proposés une seule fois (s'ils sont supprimés, ils ne reviennent pas).
        var versionFile = Path.Combine(dir, "dashboards-defaults.txt");
        var known = File.Exists(versionFile) && int.TryParse(File.ReadAllText(versionFile).Trim(), out var v) ? v : exists ? 1 : DefaultsVersion;
        if (known < DefaultsVersion)
        {
            foreach (var d in Defaults().Where(d => AddedIn(d.Id) > known && _dashboards.All(x => x.Id != d.Id))) _dashboards.Add(d);
            exists = false;
        }
        File.WriteAllText(versionFile, DefaultsVersion.ToString());
        if (!exists) Save();
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
        d.Variables ??= [];
        // Nom de variable : lettres, chiffres et _ (utilisé sous la forme $nom).
        d.Variables = d.Variables
            .Select(v => { v.Name = new string((v.Name ?? "").Trim().Where(c => char.IsLetterOrDigit(c) || c == '_').ToArray()); return v; })
            .Where(v => v.Name.Length > 0 && !string.IsNullOrWhiteSpace(v.Field))
            .DistinctBy(v => v.Name).ToList();
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
    /// <summary>Version des tableaux par défaut (2 : « Expérience navigateur »).</summary>
    private const int DefaultsVersion = 2;

    private static int AddedIn(string id) => id switch { "browser" => 2, _ => 1 };

    private static List<Dashboard> Defaults() =>
    [
        new Dashboard
        {
            Id = "http",
            Name = "Santé HTTP",
            Description = "Débit, erreurs et latence des requêtes reçues, par route.",
            Variables = [new DashboardVariable { Name = "route", Label = "Route", Field = "http.route", Source = "spans" }],
            Panels =
            [
                new Panel { Title = "Requêtes / s", Type = "stat", Source = "http", Stat = "rate", Query = "$route", Width = 3, Height = "s" },
                new Panel { Title = "Taux d'erreur", Type = "stat", Source = "http", Stat = "errorRate", Query = "$route", Width = 3, Height = "s" },
                new Panel { Title = "Latence p95", Type = "stat", Source = "http", Stat = "p95", Query = "$route", Width = 3, Height = "s" },
                new Panel { Title = "Erreurs (logs)", Type = "stat", Source = "logs", Level = "error", Width = 3, Height = "s" },
                new Panel { Title = "Requêtes par route", Type = "http", Stat = "rate", GroupBy = "route", Query = "$route", Width = 6 },
                new Panel { Title = "Latence p95 par route", Type = "http", Stat = "p95", GroupBy = "route", Query = "$route", Width = 6 },
                new Panel { Title = "Réponses par code HTTP", Type = "http", Stat = "rate", GroupBy = "status", Query = "$route", Width = 6 },
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
            Id = "browser",
            Name = "Expérience navigateur",
            Description = "Web Vitals, chargement des pages, erreurs JavaScript et appels réseau vus depuis le navigateur (script vigil-rum.js).",
            Panels =
            [
                new Panel { Title = "LCP p75 (affichage principal)", Type = "custom", DataSource = "metrics", Query = "name:browser.web_vital.lcp", Aggregate = "p75", Field = "value", View = "stat", Width = 3, Height = "s" },
                new Panel { Title = "INP p75 (réactivité)", Type = "custom", DataSource = "metrics", Query = "name:browser.web_vital.inp", Aggregate = "p75", Field = "value", View = "stat", Width = 3, Height = "s" },
                new Panel { Title = "CLS p75 (stabilité)", Type = "custom", DataSource = "metrics", Query = "name:browser.web_vital.cls", Aggregate = "p75", Field = "value", View = "stat", Width = 3, Height = "s" },
                new Panel { Title = "Erreurs JavaScript", Type = "custom", DataSource = "logs", Query = "log.category:navigateur", Aggregate = "count", View = "stat", Width = 3, Height = "s" },
                new Panel { Title = "Chargement des pages p75 (ms)", Type = "custom", DataSource = "metrics", Query = "name:browser.page.load", Aggregate = "p75", Field = "value", GroupBy = "url.path", View = "timeseries", Width = 6 },
                new Panel { Title = "Pages les plus lentes (LCP p75, ms)", Type = "custom", DataSource = "metrics", Query = "name:browser.web_vital.lcp", Aggregate = "p75", Field = "value", GroupBy = "url.path", View = "top", Width = 6 },
                new Panel { Title = "Erreurs JavaScript par type", Type = "custom", DataSource = "logs", Query = "log.category:navigateur", Aggregate = "count", GroupBy = "exception", View = "top", Width = 6 },
                new Panel { Title = "Appels réseau depuis le navigateur (p95, ms)", Type = "custom", DataSource = "spans", Query = "kind:client browser.name:*", Aggregate = "p95", Field = "duration", GroupBy = "name", View = "top", Width = 6 },
                new Panel { Title = "Navigateurs", Type = "custom", DataSource = "spans", Query = "browser.name:*", Aggregate = "count", GroupBy = "browser.name", View = "top", Width = 6 },
                new Panel { Title = "Pages vues", Type = "custom", DataSource = "spans", Query = "browser.navigation:*", Aggregate = "count", GroupBy = "url.path", View = "top", Width = 6 },
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
