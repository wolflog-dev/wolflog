namespace Wolflog.Server.Monitoring;

/// <summary>Paramètres d'envoi (un seul document, id "mail").</summary>
public sealed class NotificationSettings : IEntity
{
    public string Id { get; set; } = "mail";
    /// <summary>Adresse publique de Wolflog, pour les liens dans les notifications (ex. https://wolflog.mondomaine.fr).</summary>
    public string? PublicUrl { get; set; }
    public string? SmtpHost { get; set; }
    public int SmtpPort { get; set; } = 587;
    public bool SmtpSsl { get; set; } = true;
    public string? SmtpUser { get; set; }
    public string? SmtpPassword { get; set; }
    public string? From { get; set; }
}
