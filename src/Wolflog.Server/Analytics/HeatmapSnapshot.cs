namespace Wolflog.Server.Analytics;

/// <summary>
/// Capture d'une page pour les cartes de chaleur, faite par le script navigateur d'un visiteur : structure et styles de la page,
/// texte du contenu masqué, valeurs des champs et images retirées. Width : largeur de la fenêtre à la capture ; Height : hauteur
/// du document.
/// </summary>
public sealed record HeatmapSnapshot(string Service, string Path, string Device, int Width, int Height, DateTime CapturedAt, string Html);
