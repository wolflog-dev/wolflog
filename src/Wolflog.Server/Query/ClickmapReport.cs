namespace Wolflog.Server.Query;

/// <summary>Carte d'une page : gabarit représentatif, clics agrégés, éléments cliqués et défilement.</summary>
public sealed record ClickmapReport(string? Host, int Width, int Height, int Fold, long Clicks, long Views, long Rage, long Dead, double AvgScroll,
    List<ClickmapPoint> Points, List<ClickmapElement> Elements, List<ScrollReach> Scroll);
