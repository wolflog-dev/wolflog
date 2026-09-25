namespace Wolflog.Server.Monitoring;

/// <summary>Sonde de disponibilité : appel HTTP(S) ou connexion TCP à intervalle régulier.</summary>
public sealed class Probe : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    /// <summary>http ou tcp.</summary>
    public string Type { get; set; } = "http";
    /// <summary>URL (http) ou hôte:port (tcp).</summary>
    public string Target { get; set; } = "";
    public string Method { get; set; } = "GET";
    public int IntervalSeconds { get; set; } = 60;
    public int TimeoutSeconds { get; set; } = 10;
    /// <summary>Codes acceptés, ex. "200-399" ou "200,204".</summary>
    public string ExpectedStatus { get; set; } = "200-399";
    /// <summary>Texte qui doit apparaître dans la réponse (facultatif).</summary>
    public string? ExpectedText { get; set; }
    /// <summary>Échecs consécutifs avant de considérer la cible en panne.</summary>
    public int FailuresBeforeDown { get; set; } = 2;
    /// <summary>Service associé (pour relier la sonde aux logs et traces).</summary>
    public string? Service { get; set; }
    public bool IgnoreTlsErrors { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
