namespace Wolflog.Server.Dashboards;

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
