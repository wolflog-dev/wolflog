namespace Wolflog.Server.Monitoring;

public sealed class ProfileInfo : IEntity
{
    public string Id { get; set; } = "";
    public string Service { get; set; } = "";
    public string Instance { get; set; } = "";
    public string? Host { get; set; }
    public string? Version { get; set; }
    /// <summary>cpu ou alloc.</summary>
    public string Kind { get; set; } = "cpu";
    public DateTime Start { get; set; }
    public double Seconds { get; set; }
    public long Samples { get; set; }
    /// <summary>Somme des poids (échantillons ou octets alloués).</summary>
    public long Total { get; set; }
    public string? Error { get; set; }
    /// <summary>pending (demandé, pas encore reçu), done, failed.</summary>
    public string Status { get; set; } = "pending";
    public string? RequestedBy { get; set; }
    public DateTime RequestedAt { get; set; } = DateTime.UtcNow;
}
