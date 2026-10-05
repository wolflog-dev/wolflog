namespace Wolflog.Server.Analytics;

/// <summary>
/// Ligne d'audience web : page vue, événement, clic ou défilement.
/// Aucune IP, aucun cookie : le visiteur est une empreinte à sel éphémère, et un utilisateur connecté
/// n'apparaît que sous un pseudonyme (voir <see cref="VisitorIdentity"/>).
/// </summary>
public sealed class AnalyticsRow
{
    public DateTime Ts;
    public string Service = "";
    public string? Env;
    public byte Kind;
    public string Visitor = "";
    public string Visit = "";
    public string Path = "/";
    public string? Title;
    public string? Hostname;
    public string? ReferrerDomain;
    public string? UtmSource;
    public string? UtmMedium;
    public string? UtmCampaign;
    public string? EventName;
    public string? EventData;
    public string? Browser;
    public string? Os;
    public string? Device;
    public string? Screen;
    public string? Language;
    public string? Country;
    /// <summary>Origine de la mesure : browser (script RUM) ou server (Wolflog.Client.Blazor, API).</summary>
    public string Source = "browser";
    // Cartes de chaleur
    public int? Vw;
    public int? Vh;
    public int? DocH;
    /// <summary>Position horizontale en 1/10 000 de la largeur du document.</summary>
    public int? X;
    /// <summary>Position verticale en pixels depuis le haut du document.</summary>
    public int? Y;
    public string? Selector;
    public string? Label;
    public bool Rage;
    public bool Dead;
    /// <summary>Défilement maximal atteint (% du document).</summary>
    public byte? Depth;
    /// <summary>Utilisateur identifié par l'application : pseudonyme stable (<see cref="VisitorIdentity.User"/>), sinon null.</summary>
    public string? UserKey;
}
