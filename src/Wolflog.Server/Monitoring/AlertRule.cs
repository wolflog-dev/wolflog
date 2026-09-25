namespace Wolflog.Server.Monitoring;

public sealed class AlertRule : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public string Kind { get; set; } = AlertKinds.Http;
    /// <summary>critical ou warning.</summary>
    public string Severity { get; set; } = "critical";

    // Portée
    public string? Service { get; set; }
    public string? Env { get; set; }

    // Requête personnalisée
    public string? Source { get; set; }
    public string? Filter { get; set; }
    public string? Aggregate { get; set; }
    public string? Field { get; set; }
    /// <summary>Évaluation séparée par valeur de ce champ (ex. service, http.route).</summary>
    public string? GroupBy { get; set; }

    // HTTP : errorRate, p95, p99, rate, count
    public string? Stat { get; set; }
    public string? Route { get; set; }
    /// <summary>Une évaluation par service (au lieu du total).</summary>
    public bool PerService { get; set; }

    // Erreurs
    public bool IncludeRegressions { get; set; } = true;
    public bool CrashesOnly { get; set; }

    // Sonde, SLO
    public string? TargetId { get; set; }

    // Seuil
    /// <summary>above ou below.</summary>
    public string Comparison { get; set; } = "above";
    public double Threshold { get; set; }
    /// <summary>Fenêtre d'évaluation.</summary>
    public int WindowMinutes { get; set; } = 5;
    /// <summary>Durée pendant laquelle la condition doit rester vraie avant de déclencher (0 = immédiat).</summary>
    public int ForMinutes { get; set; }
    /// <summary>Rappel tant que l'alerte reste active (0 = jamais).</summary>
    public int RepeatMinutes { get; set; }
    /// <summary>Pas de notification tant que moins de N événements (évite les faux positifs à faible trafic).</summary>
    public long MinCount { get; set; }

    public List<string> Channels { get; set; } = [];
    public bool NotifyResolved { get; set; } = true;
    /// <summary>Consigne pour la personne d'astreinte (lien vers une procédure…).</summary>
    public string? Runbook { get; set; }
    public DateTime? MutedUntil { get; set; }
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
