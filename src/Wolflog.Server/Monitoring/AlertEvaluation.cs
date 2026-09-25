namespace Wolflog.Server.Monitoring;

/// <summary>Résultat de l'évaluation d'une règle pour une clé (total, un service, une erreur…).</summary>
public sealed record AlertEvaluation(string Key, bool Breach, double? Value, string Message, string? Link, bool IsEvent = false);
