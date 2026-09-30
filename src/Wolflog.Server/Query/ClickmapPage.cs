namespace Wolflog.Server.Query;

/// <summary>Page disposant de clics ou de mesures de défilement.</summary>
public sealed record ClickmapPage(string Path, long Clicks, long Views, long Rage, long Dead);
