namespace Wolflog.Server.Query;

/// <summary>Visiteurs ayant franchi chaque étape, dans l'ordre et dans la fenêtre de temps.</summary>
public sealed record AnalyticsFunnel(List<AnalyticsFunnelStep> Steps, List<long> Counts);
