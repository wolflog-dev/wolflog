namespace Wolflog.Server.Monitoring;

public sealed record AlertNotification(
    string Status, string RuleName, string Severity, string Message, string? Link, string? Runbook, DateTime At)
{
    /// <summary>Variables propres à la règle et à l'évaluation (service, valeur, seuil…), pour les modèles de message.</summary>
    public IReadOnlyDictionary<string, string?> Data { get; init; } = new Dictionary<string, string?>();

    /// <summary>Modèles de la règle ; null = modèle par défaut (Alertes > Canaux).</summary>
    public string? TitleTemplate { get; init; }
    public string? BodyTemplate { get; init; }
}
