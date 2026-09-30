namespace Wolflog.Server.Query;

/// <summary>Élément cliqué (sélecteur CSS et libellé des liens et boutons).</summary>
public sealed record ClickmapElement(string? Selector, string? Label, long Clicks, long Rage, long Dead);
