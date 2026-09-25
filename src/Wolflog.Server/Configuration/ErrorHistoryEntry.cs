namespace Wolflog.Server.Configuration;

// ---------------------------------------------------------------------- statut des erreurs

public sealed class ErrorHistoryEntry
{
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string? By { get; set; }
    public string Action { get; set; } = "";
}
