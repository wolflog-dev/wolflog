namespace Wolflog.Server.Monitoring;

/// <summary>
/// Objectif de service : part minimale d'événements « bons » sur une fenêtre glissante
/// (ex. 99,9 % des requêtes sans erreur serveur sur 30 jours).
/// </summary>
public sealed class Slo : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>availability (sans erreur) ou latency (plus rapide que LatencyMs).</summary>
    public string Kind { get; set; } = "availability";
    /// <summary>http (requêtes entrantes d'un service) ou probe (résultats d'une sonde).</summary>
    public string Source { get; set; } = "http";
    public string? Service { get; set; }
    /// <summary>Filtre sur la route ou le chemin (facultatif).</summary>
    public string? Route { get; set; }
    public string? ProbeId { get; set; }
    public double TargetPercent { get; set; } = 99.9;
    public double LatencyMs { get; set; } = 500;
    public int WindowDays { get; set; } = 30;
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
