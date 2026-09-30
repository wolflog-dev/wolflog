namespace Wolflog.Server.Monitoring;

/// <summary>
/// Notification rendue pour l'aperçu de l'éditeur : titre, corps HTML (e-mail, Teams), mrkdwn (Slack), texte brut.
/// Tone : Good, Warning ou Attention (couleur du titre dans Teams).
/// </summary>
public sealed record MessagePreview(string Title, string Html, string Slack, string Text, string? Link, string Tone);
