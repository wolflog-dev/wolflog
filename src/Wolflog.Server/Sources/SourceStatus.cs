namespace Wolflog.Server.Sources;

/// <summary>État d'une source en cours d'exécution.</summary>
public sealed class SourceStatus
{
    public string State { get; set; } = "starting";
    public long Entries { get; set; }
    public DateTime? LastEntryAt { get; set; }
    public string? LastError { get; set; }
    public DateTime? LastErrorAt { get; set; }
    public int Files { get; set; }
    public string? Detail { get; set; }
}
