namespace Wolflog.Server.Monitoring;

public sealed class AlertChannel : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>email, teams, slack, webhook.</summary>
    public string Type { get; set; } = "email";
    /// <summary>Adresses (séparées par des virgules) ou URL du webhook.</summary>
    public string Target { get; set; } = "";
    /// <summary>Canal ajouté automatiquement à toutes les nouvelles règles.</summary>
    public bool Default { get; set; }
    public DateTime? LastSentAt { get; set; }
    public DateTime? LastErrorAt { get; set; }
    public string? LastError { get; set; }
}
