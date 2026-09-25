namespace Wolflog.Server.Monitoring;

/// <summary>
/// État d'un objectif (SLO) sur sa fenêtre. <c>BudgetRemaining</c> : part du budget d'erreur restante (100 = intact, négatif = dépassé).
/// <c>State</c> : ok, warning (budget &lt; 25 % ou consommation rapide), breached (objectif non tenu).
/// </summary>
public sealed record SloStatus(
    string Id, long Total, long Bad, double? Sli, double TargetPercent,
    double? BudgetRemaining,
    double? BurnRate1h, double? BurnRate6h,
    string State);
