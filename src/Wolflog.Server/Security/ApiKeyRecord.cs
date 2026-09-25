namespace Wolflog.Server.Security;

/// <summary>Clé d'ingestion. La clé elle-même n'est jamais stockée : seulement son empreinte SHA-256.</summary>
public sealed class ApiKeyRecord : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>server (applications) ou browser (script navigateur, visible publiquement : envoi RUM uniquement).</summary>
    public string Kind { get; set; } = "server";
    public string Prefix { get; set; } = "";
    public string Hash { get; set; } = "";
    public List<string> AllowedOrigins { get; set; } = [];
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public string? CreatedBy { get; set; }
    public DateTime? LastUsedAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}
