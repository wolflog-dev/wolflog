namespace Wolflog.Server.Query;

/// <summary>Application qui a envoyé des données dans un environnement, avec les valeurs d'environnement qu'elle envoie.</summary>
public sealed record EnvironmentApp(string Service, IReadOnlyList<string> Raw);
