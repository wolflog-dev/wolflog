namespace Wolflog.Server.Query;

/// <summary>
/// Requêtes HTTP d'un groupe (ou de l'ensemble) pour une alerte : Total = requêtes concernées, Matched = celles qui
/// remplissent la condition sur la réponse, Errors = parmi elles, les erreurs ; durées (ms) calculées sur Matched.
/// </summary>
public sealed record HttpAlertRow(string Group, long Total, long Matched, long Errors,
    double? P50Ms, double? P90Ms, double? P95Ms, double? P99Ms, double? AvgMs, double? MaxMs);
