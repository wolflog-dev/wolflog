namespace Wolflog.Server.Monitoring;

public sealed record SloPoint(DateTime T, double? Sli, double? BudgetRemaining);
