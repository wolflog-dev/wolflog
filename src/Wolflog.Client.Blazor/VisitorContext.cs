using System.Diagnostics;
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
    /// <summary>Identifiant lu dans la requête HTTP par l'option UserIdFromRequest (authentification maison, ex. session).</summary>
    public string? RequestUser { get; private set; }
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

    /// <summary>
    /// Comme <see cref="Capture(HttpContext?)"/>, plus l'identifiant lu par <see cref="WolflogBlazorOptions.UserIdFromRequest"/>
    /// (une fois connu, il n'est plus relu : la session n'est chargée qu'une fois). Une lecture en échec (session non
    /// configurée, base de la session injoignable) laisse l'utilisateur inconnu ; l'application continue.
    /// </summary>
    internal void Capture(HttpContext? ctx, WolflogBlazorOptions options)
    {
        Capture(ctx);
        if (ctx is null || RequestUser is not null || !options.TrackUsers || options.UserIdFromRequest is not { } read) return;
        try
        {
            RequestUser = read(ctx) is { } id && !string.IsNullOrWhiteSpace(id) ? id.Trim() : null;
        }
        catch (Exception ex)
        {
            Trace.TraceWarning($"Wolflog : utilisateur illisible dans la requête ({ex.GetType().Name}: {ex.Message})");
        }
    }
}
