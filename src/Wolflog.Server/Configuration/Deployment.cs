namespace Wolflog.Server.Configuration;

// ---------------------------------------------------------------------- déploiements

public sealed class Deployment : IEntity
{
    public string Id { get; set; } = "";
    public string Service { get; set; } = "";
    public string? Env { get; set; }
    public string Version { get; set; } = "";
    public DateTime At { get; set; }
    /// <summary>auto (nouvelle version détectée), initial (première version vue), api (déclaré par la CI).</summary>
    public string Source { get; set; } = "auto";
    public string? Description { get; set; }
    public string? By { get; set; }
}
