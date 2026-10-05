using System.Security.Claims;

namespace Wolflog.Client.Blazor;

/// <summary>
/// Configuration de Wolflog.Client.Blazor. Lue dans la section "Wolflog" (Endpoint, ApiKey, ServiceName, Environment),
/// comme Wolflog.Client : une seule configuration pour les deux paquets.
/// </summary>
public sealed class WolflogBlazorOptions
{
    /// <summary>Active ou désactive complètement l'envoi.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Adresse du serveur Wolflog, ex. https://wolflog.mondomaine.fr.</summary>
    public string? Endpoint { get; set; }

    /// <summary>Clé API de type « serveur ».</summary>
    public string? ApiKey { get; set; }

    /// <summary>Nom du service (site). Par défaut : nom de l'application.</summary>
    public string? ServiceName { get; set; }

    /// <summary>Environnement (Production, Staging…). Par défaut : IHostEnvironment.EnvironmentName.</summary>
    public string? Environment { get; set; }

    /// <summary>
    /// Pages vues mesurées côté serveur à chaque navigation Blazor (invisible pour les bloqueurs de publicité).
    /// Laissez false si le script navigateur wolflog-rum.js mesure déjà les pages, ou ajoutez-lui data-pageviews="server".
    /// </summary>
    public bool TrackNavigation { get; set; }

    /// <summary>Coupures et reprises de la connexion SignalR, durée des circuits.</summary>
    public bool TrackCircuits { get; set; } = true;

    /// <summary>
    /// Utilisateurs uniques : l'identifiant de l'utilisateur connecté accompagne chaque mesure. Wolflog le remplace aussitôt
    /// par un pseudonyme (clé propre au serveur) et ne le stocke jamais ; informez-en vos utilisateurs.
    /// Le script navigateur wolflog-rum.js de la page reçoit aussi l'identifiant, pour ses clics et événements.
    /// </summary>
    public bool TrackUsers { get; set; }

    /// <summary>
    /// Identifiant retenu pour un utilisateur connecté. Par défaut : objet Entra ID (oid), sinon identifiant du compte
    /// (NameIdentifier, sub), sinon nom de connexion (DOMAINE\compte en authentification Windows).
    /// </summary>
    public Func<ClaimsPrincipal, string?>? UserId { get; set; }

    /// <summary>
    /// Identifiant de l'utilisateur lu dans la requête HTTP, pour une authentification maison qui ne remplit pas
    /// HttpContext.User : par exemple un utilisateur gardé dans la session (cache SQL Server compris),
    /// <c>o.UserIdFromRequest = ctx => ctx.Session.GetString("Login")</c>. Lu à l'affichage de la page et à l'ouverture
    /// du circuit Blazor (la session doit donc être active aussi pour /_blazor) ; prioritaire sur <see cref="UserId"/>.
    /// </summary>
    public Func<HttpContext, string?>? UserIdFromRequest { get; set; }

    /// <summary>Chemins jamais mesurés (préfixes), ex. /admin.</summary>
    public List<string> ExcludedPaths { get; set; } = [];

    /// <summary>Délai maximum avant envoi d'un lot.</summary>
    public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>Identifiant transmis pour ce visiteur : celui lu dans la requête (<see cref="UserIdFromRequest"/>), sinon celui de l'utilisateur connecté.</summary>
    internal string? UserFor(VisitorContext visitor) => TrackUsers ? visitor.RequestUser ?? UserOf(visitor.User) : null;

    /// <summary>Identifiant transmis pour cet utilisateur, ou null (anonyme, ou <see cref="TrackUsers"/> désactivé).</summary>
    internal string? UserOf(ClaimsPrincipal? principal)
    {
        if (!TrackUsers || principal?.Identity?.IsAuthenticated != true) return null;
        var id = UserId is not null
            ? UserId(principal)
            : principal.FindFirst("http://schemas.microsoft.com/identity/claims/objectidentifier")?.Value
              ?? principal.FindFirst("oid")?.Value
              ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value
              ?? principal.FindFirst("sub")?.Value
              ?? principal.Identity.Name;
        return string.IsNullOrWhiteSpace(id) ? null : id;
    }
}
