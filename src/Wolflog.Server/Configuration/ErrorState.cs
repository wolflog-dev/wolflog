namespace Wolflog.Server.Configuration;

/// <summary>Suivi d'un groupe d'erreurs (clé = empreinte).</summary>
public sealed class ErrorState : IEntity
{
    public string Id { get; set; } = "";
    /// <summary>open, resolved ou ignored. "regressed" est calculé : résolue puis revue ensuite.</summary>
    public string Status { get; set; } = "open";
    public DateTime? ResolvedAt { get; set; }
    public string? AssignedTo { get; set; }
    public string? Note { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<ErrorHistoryEntry> History { get; set; } = [];
}
