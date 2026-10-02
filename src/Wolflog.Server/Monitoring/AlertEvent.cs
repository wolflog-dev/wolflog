namespace Wolflog.Server.Monitoring;

public sealed class AlertEvent : IEntity
{
    public string Id { get; set; } = "";
    public string RuleId { get; set; } = "";
    public string RuleName { get; set; } = "";
    public string Key { get; set; } = "";
    /// <summary>Service concerné (règle d'un service, ou élément d'une règle globale) : filtre de l'historique selon le profil d'accès.</summary>
    public string? Service { get; set; }
    /// <summary>firing ou resolved.</summary>
    public string Status { get; set; } = "firing";
    public string Severity { get; set; } = "critical";
    public DateTime At { get; set; } = DateTime.UtcNow;
    public double? Value { get; set; }
    public string? Message { get; set; }
    public string? Link { get; set; }
    public List<string> NotifiedChannels { get; set; } = [];
}
