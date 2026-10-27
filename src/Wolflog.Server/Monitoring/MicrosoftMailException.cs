namespace Wolflog.Server.Monitoring;

/// <summary>Connexion Microsoft (OAuth) impossible pour une messagerie : message déjà traduit en consigne.</summary>
public sealed class MicrosoftMailException(string message) : Exception(message);
