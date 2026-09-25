namespace Wolflog.Server.Query;

/// <summary>Appels d'un nœud vers un autre sur la période.</summary>
public sealed record MapEdge(string Source, string Target, long Calls, long Errors, double? P95Ms);
