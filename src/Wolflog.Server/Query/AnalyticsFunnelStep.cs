namespace Wolflog.Server.Query;

/// <summary>Étape d'entonnoir : page (<c>url</c>, joker *) ou événement (<c>event</c>).</summary>
public sealed record AnalyticsFunnelStep(string Type, string Value);
