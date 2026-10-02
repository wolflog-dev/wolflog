namespace Wolflog.Server.Query;

/// <summary>Valeur d'environnement reçue d'une application (logs et spans) : volumes et dernière donnée.</summary>
public sealed record EnvironmentUsage(string Service, string Env, long Logs, long Errors, long Spans, DateTime? LastSeen);
