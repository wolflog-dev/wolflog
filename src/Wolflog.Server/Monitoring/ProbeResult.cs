namespace Wolflog.Server.Monitoring;

/// <summary>
/// Résultat d'une vérification. Sonde e-mail : DurationMs = délai de livraison (envoi → arrivée) si la réception est
/// vérifiée, sinon durée de l'envoi ; Steps détaille chaque étape ; Warning signale un problème non bloquant.
/// </summary>
public sealed record ProbeResult(DateTime At, bool Ok, double DurationMs, int? Status, string? Error, int? CertificateDays,
    IReadOnlyList<ProbeStep>? Steps = null, string? Warning = null);
