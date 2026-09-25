namespace Wolflog.Server.Monitoring;

/// <summary>Instance d'application qui peut être profilée (paquet Wolflog.Client.Profiling), vue récemment.</summary>
public sealed record ProfilingInstance(string Service, string Instance, string? Host, string? Version, string? Runtime, DateTime LastSeen);
