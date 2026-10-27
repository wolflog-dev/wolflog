namespace Wolflog.Server.Monitoring;

/// <summary>Étape d'une vérification (connexion, TLS, authentification, envoi, réception…), avec sa durée.</summary>
public sealed record ProbeStep(string Name, bool Ok, double DurationMs, string? Detail = null);
