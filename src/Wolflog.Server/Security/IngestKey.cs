namespace Wolflog.Server.Security;

/// <summary>Résultat de la vérification d'une clé d'ingestion.</summary>
public sealed record IngestKey(string Name, string Kind, IReadOnlyList<string> AllowedOrigins);
