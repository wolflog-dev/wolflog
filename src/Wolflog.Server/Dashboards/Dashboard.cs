using System.Text.Json.Serialization;

namespace Wolflog.Server.Dashboards;

public sealed class Dashboard
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..10];
    public string Name { get; set; } = "Nouveau tableau de bord";
    public string? Description { get; set; }
    public List<Panel> Panels { get; set; } = [];
    public List<DashboardVariable> Variables { get; set; } = [];
    /// <summary>Profils d'accès qui voient ce tableau ; vide : tout le monde. Les administrateurs voient tout.</summary>
    public List<string> VisibleTo { get; set; } = [];
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    /// <summary>Panneaux retirés de la réponse (hors du profil d'accès de la personne) ; jamais enregistré.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? HiddenPanels { get; set; }
}
