namespace Wolflog.Server.Analytics;

/// <summary>
/// Ce qu'un jeton de carte sur le site permet de lire : les clics d'un service (ou des services visibles de la personne qui
/// l'a demandé, si aucun n'était choisi : <c>Services</c>, vide pour tous), dans l'environnement et sur la période choisis à
/// sa création. Période relative (<c>Live</c>, « 7 derniers jours ») : elle glisse avec le temps, comme dans l'interface.
/// </summary>
public sealed record HeatmapViewerGrant(string? Service, IReadOnlyList<string> Services, string? Env, DateTime From, DateTime To, bool Live, string? User)
{
    /// <summary>Période à lire maintenant.</summary>
    public (DateTime From, DateTime To) Range(DateTime now) => Live ? (now - (To - From), now) : (From, To);
}
