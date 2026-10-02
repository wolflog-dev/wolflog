namespace Wolflog.Server.Security;

public sealed class User : IEntity
{
    public string Id { get; set; } = "";
    public string Username { get; set; } = "";
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
    public string Role { get; set; } = Roles.Viewer;
    /// <summary>Profil d'accès (parties de Wolflog visibles). null = tout voir. Ignoré pour les administrateurs.</summary>
    public string? ProfileId { get; set; }
    /// <summary>Services visibles propres au compte : null = ceux du profil ; liste vide = tous ; sinon noms ou motifs (« boutique-* »).</summary>
    public List<string>? Services { get; set; }
    /// <summary>local ou sso.</summary>
    public string Source { get; set; } = "local";
    public string? PasswordHash { get; set; }
    public bool MustChangePassword { get; set; }
    public bool Disabled { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastLoginAt { get; set; }
}
