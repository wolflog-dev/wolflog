namespace Wolflog.Server.Query;

/// <summary>Case de la carte des clics : X en 1/10 000 de la largeur, Y en pixels.</summary>
public sealed record ClickmapPoint(int X, int Y, long Count);
