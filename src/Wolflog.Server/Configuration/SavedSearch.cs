namespace Wolflog.Server.Configuration;

// ---------------------------------------------------------------------- recherches enregistrées

public sealed class SavedSearch : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>logs, requests, traces ou errors.</summary>
    public string Page { get; set; } = "logs";
    public Dictionary<string, string> Params { get; set; } = [];
    public string? Owner { get; set; }
    public bool Shared { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
