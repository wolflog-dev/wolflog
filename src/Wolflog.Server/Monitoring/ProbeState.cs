namespace Wolflog.Server.Monitoring;

/// <summary>État courant d'une sonde (en mémoire, recalculé au démarrage).</summary>
public sealed class ProbeState
{
    /// <summary>up, down ou unknown.</summary>
    public string Status { get; set; } = "unknown";
    public DateTime Since { get; set; } = DateTime.UtcNow;
    public int ConsecutiveFailures { get; set; }
    public ProbeResult? Last { get; set; }
    public List<ProbeResult> Recent { get; set; } = [];
}
