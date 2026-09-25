namespace Wolflog.Server.Monitoring;

/// <summary>État courant d'une règle pour une clé (total, un service, une erreur…).</summary>
public sealed class AlertState : IEntity
{
    /// <summary>ruleId|clé.</summary>
    public string Id { get; set; } = "";
    public string RuleId { get; set; } = "";
    public string Key { get; set; } = "";
    /// <summary>ok, pending, firing.</summary>
    public string Status { get; set; } = "ok";
    public DateTime Since { get; set; } = DateTime.UtcNow;
    public double? Value { get; set; }
    public string? Message { get; set; }
    /// <summary>Lien vers les données dans l'interface (chemin relatif).</summary>
    public string? Link { get; set; }
    public DateTime? LastNotifiedAt { get; set; }
    public DateTime LastEvaluatedAt { get; set; } = DateTime.UtcNow;
}
