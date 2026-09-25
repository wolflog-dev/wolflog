namespace Wolflog.Server.Sources;

/// <summary>Requête HTTP lue dans un journal (IIS, accès web) : devient un span serveur.</summary>
public sealed record HttpEntry(string Method, string Path, string? Query, int Status, double DurationMs, string? ClientIp, string? UserAgent, string? Host);
