namespace Wolflog.Server.Query;

/// <summary>Part des pages vues ayant atteint une profondeur de défilement (%).</summary>
public sealed record ScrollReach(int Depth, double Share);
