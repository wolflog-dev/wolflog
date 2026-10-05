using System.Security.Claims;

namespace Wolflog.Client.Blazor;

/// <summary>
/// Visiteur du circuit en cours. L'IP et le User-Agent sont transmis à Wolflog uniquement pour calculer
/// une empreinte anonyme (sel quotidien détruit), jamais stockés ; de même, l'identifiant de l'utilisateur connecté
/// (option TrackUsers) n'y devient qu'un pseudonyme.
/// </summary>
public sealed class VisitorContext
{
    public string? Ip { get; private set; }
    public string? UserAgent { get; private set; }
    public string? Language { get; private set; }
    public string? Referrer { get; private set; }
    /// <summary>Utilisateur connecté : requête HTTP, puis état d'authentification du circuit (utilisé si TrackUsers).</summary>
    public ClaimsPrincipal? User { get; set; }
    /// <summary>Page affichée dans l'aperçu des cartes de chaleur de Wolflog : rien n'est mesuré.</summary>
    public bool Preview { get; private set; }

    /// <summary>L'aperçu du dashboard ajoute <c>wolflog-preview=1</c> à l'URL de la page.</summary>
    public void MarkPreview(string? urlOrQuery) => Preview |= urlOrQuery?.Contains("wolflog-preview=1", StringComparison.Ordinal) == true;
    public string? CurrentUrl { get; set; }
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

    /// <summary>Complète depuis la requête HTTP (ouverture du circuit ou rendu serveur).</summary>
    public void Capture(HttpContext? ctx)
    {
        if (ctx is null) return;
        var forwarded = ctx.Request.Headers["X-Forwarded-For"].ToString();
        Ip ??= forwarded.Length > 0 ? forwarded.Split(',')[0].Trim() : ctx.Connection.RemoteIpAddress?.ToString();
        UserAgent ??= ctx.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua : null;
        Language ??= ctx.Request.Headers.AcceptLanguage.ToString().Split(',')[0] is { Length: > 0 } l ? l : null;
        Referrer ??= ctx.Request.Headers.Referer.ToString() is { Length: > 0 } r ? r : null;
        if (ctx.User.Identity?.IsAuthenticated == true) User ??= ctx.User;
        MarkPreview(ctx.Request.QueryString.Value);
    }
}
