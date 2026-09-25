namespace Wolflog.Server.Query;

/// <summary>Nœud de la carte : un service instrumenté, ou une dépendance externe (base de données, API tierce, file).</summary>
public sealed record MapNode(string Id, string Name, string Kind, long Requests, long Errors, double? P95Ms, string? Detail);
