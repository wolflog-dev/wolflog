namespace Wolflog.Server.Query;

/// <summary>Élément générant des rage clicks (clics répétés) ou des dead clicks (clic sans effet).</summary>
public sealed record ClickmapFrustration(string Path, string? Selector, string? Label, long Rage, long Dead);
