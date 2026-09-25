namespace Wolflog.Server.Query;

/// <summary>Requête libre construite dans l'interface (panneau "Requête personnalisée").</summary>
public sealed record CustomQuery(
    string Source, string? Filter, string Aggregate, string? Field, string? GroupBy, string View, int Limit, string? Service);
