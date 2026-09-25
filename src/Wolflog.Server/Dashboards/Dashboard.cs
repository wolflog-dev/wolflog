namespace Wolflog.Server.Dashboards;

public sealed class Dashboard
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..10];
    public string Name { get; set; } = "Nouveau tableau de bord";
    public string? Description { get; set; }
    public List<Panel> Panels { get; set; } = [];
    public List<DashboardVariable> Variables { get; set; } = [];
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
