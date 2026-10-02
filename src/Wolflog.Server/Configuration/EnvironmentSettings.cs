namespace Wolflog.Server.Configuration;

/// <summary>
/// Environnements configurés (un seul document, id "environments", dans environments.json) : environnements communs à toutes
/// les applications, puis réglages propres à certaines. Sans réglage, chaque valeur reçue est un environnement, comme avant.
/// </summary>
public sealed class EnvironmentSettings : IEntity
{
    public string Id { get; set; } = EnvironmentStore.DocumentId;
    /// <summary>Environnements dans l'ordre du sélecteur.</summary>
    public List<EnvironmentDefinition> Environments { get; set; } = [];
    public List<AppEnvironments> Apps { get; set; } = [];
    public DateTime? UpdatedAt { get; set; }
    public string? UpdatedBy { get; set; }
}
