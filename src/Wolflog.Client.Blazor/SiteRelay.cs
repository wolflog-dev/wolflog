using System.Net;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Hosting;

namespace Wolflog.Client.Blazor;

/// <summary>
/// Relais par le site, sous /_wolflog : le navigateur ne s'adresse qu'au site, qui joint Wolflog côté serveur. Rien n'est donc
/// bloqué comme « contenu mixte » (site en HTTPS, Wolflog en HTTP sur une adresse IP) ni par un certificat que le navigateur ne
/// connaît pas, ni par un bloqueur de publicité.
/// <list type="bullet">
/// <item>/_wolflog/heatmap : carte de chaleur affichée sur le site (« Ouvrir sur le site »), son script et ses clics ;</item>
/// <item>/_wolflog/wolflog-rum.js : script navigateur, dont les envois (/v1/rum, captures de page) passent alors par le site.</item>
/// </list>
/// Seules ces routes sont relayées, vers le serveur Wolflog configuré.
/// </summary>
internal static class SiteRelay
{
    public const string Prefix = "/_wolflog";
    private const long MaxBody = 3 * 1024 * 1024;
    private static readonly HttpClient Shared = new() { Timeout = TimeSpan.FromSeconds(15) };
    /// <summary>En-têtes du visiteur utiles à Wolflog : site d'origine (clé navigateur), navigateur, langue, pays (CDN).</summary>
    private static readonly string[] VisitorHeaders =
        ["Origin", "User-Agent", "Accept-Language", "cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code", "x-appengine-country"];

    /// <summary>Répond à la requête si elle est l'une des routes relayées ; false sinon (la requête continue).</summary>
    public static async Task<bool> TryHandleAsync(HttpContext ctx, Uri wolflog)
    {
        if (!ctx.Request.Path.StartsWithSegments(Prefix, StringComparison.OrdinalIgnoreCase, out var rest)) return false;
        var server = wolflog.AbsoluteUri.TrimEnd('/');
        var query = ctx.Request.QueryString.Value;
        var get = HttpMethods.IsGet(ctx.Request.Method);
        var post = HttpMethods.IsPost(ctx.Request.Method);
        switch ((rest.Value ?? "").ToLowerInvariant())
        {
            case "/heatmap" when get:
                await WritePage(ctx);
                return true;
            case "/heatmap.js" when get:
                await RelayAsync(ctx, $"{server}/wolflog-heatmap.js", visitor: false);
                return true;
            case "/api/heatmap/pages" or "/api/heatmap/clickmap" when get:
                await RelayAsync(ctx, $"{server}{rest.Value!.ToLowerInvariant()}{query}", visitor: false);
                return true;
            case "/wolflog-rum.js" when get:
                await RelayAsync(ctx, $"{server}/wolflog-rum.js", visitor: false);
                return true;
            case "/v1/rum" when post:
            case "/v1/rum/snapshot" when get || post:
                await RelayAsync(ctx, $"{server}{rest.Value!.ToLowerInvariant()}{query}", visitor: true);
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Page vide de la carte sur le site, qui charge son script relayé par le site. Elle ne contient aucune donnée : les clics sont
    /// lus avec le jeton du lien, les pages du site avec la session de la personne.
    /// </summary>
    private static Task WritePage(HttpContext ctx)
    {
        var script = WebUtility.HtmlEncode(ctx.Request.PathBase + Prefix + "/heatmap.js");
        ctx.Response.ContentType = "text/html; charset=utf-8";
        ctx.Response.Headers.CacheControl = "no-store";
        ctx.Response.Headers.XContentTypeOptions = "nosniff";
        // Le lien contient le jeton : aucun référent envoyé, aucun affichage dans le cadre d'un autre site.
        ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
        ctx.Response.Headers.ContentSecurityPolicy = "frame-ancestors 'self'";
        return ctx.Response.WriteAsync($"""
            <!doctype html>
            <html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
            <meta name="robots" content="noindex"><title>Carte de chaleur · Wolflog</title>
            <script src="{script}" defer></script>
            </head><body></body></html>
            """);
    }

    /// <summary>
    /// Relaie la requête vers Wolflog et recopie la réponse. visitor : envoi du script navigateur, accompagné de l'adresse IP du
    /// visiteur (X-Forwarded-For, pour l'empreinte anonyme) et de ses en-têtes utiles.
    /// </summary>
    private static async Task RelayAsync(HttpContext ctx, string url, bool visitor)
    {
        var client = ctx.RequestServices.GetService<IHttpClientFactory>()?.CreateClient(WolflogBlazorExtensions.HttpClientName) ?? Shared;
        using var request = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), url);
        if (HttpMethods.IsPost(ctx.Request.Method))
        {
            if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit) limit.MaxRequestBodySize = MaxBody;
            if (ctx.Request.ContentLength > MaxBody)
            {
                ctx.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                return;
            }
            request.Content = new StreamContent(ctx.Request.Body);
            request.Content.Headers.TryAddWithoutValidation("Content-Type", ctx.Request.ContentType ?? "text/plain");
        }
        if (ctx.Request.Headers.Authorization.ToString() is { Length: > 0 } authorization)
            request.Headers.TryAddWithoutValidation("Authorization", authorization);
        if (visitor)
        {
            foreach (var name in VisitorHeaders)
                if (ctx.Request.Headers[name].ToString() is { Length: > 0 } value) request.Headers.TryAddWithoutValidation(name, value);
            if (ctx.Request.Headers.Origin.ToString().Length == 0 && PageOrigin(ctx.Request) is { } origin)
                request.Headers.TryAddWithoutValidation("Origin", origin);
            var forwarded = ctx.Request.Headers["X-Forwarded-For"].ToString();
            var ip = forwarded.Length > 0 ? forwarded.Split(',')[0].Trim() : ctx.Connection.RemoteIpAddress?.ToString();
            if (!string.IsNullOrEmpty(ip)) request.Headers.TryAddWithoutValidation("X-Forwarded-For", ip);
        }
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);
            ctx.Response.StatusCode = (int)response.StatusCode;
            if (response.Content.Headers.ContentType is { } type) ctx.Response.ContentType = type.ToString();
            ctx.Response.Headers.CacheControl = response.Headers.CacheControl?.ToString() ?? "no-store";
            await response.Content.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ctx.RequestAborted.IsCancellationRequested && !ctx.Response.HasStarted)
        {
            ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
            ctx.Response.Headers.CacheControl = "no-store";
            await ctx.Response.WriteAsJsonAsync(new { error = $"Le site n'arrive pas à joindre Wolflog ({new Uri(url).GetLeftPart(UriPartial.Authority)}) : vérifiez Wolflog:Endpoint." });
        }
    }

    /// <summary>
    /// Site de la page appelante quand le navigateur n'envoie pas Origin (GET d'une page vers son propre site) : celui de son
    /// adresse (Referer), sinon le site demandé. Rien pour une requête venue d'un autre site : la clé navigateur reste limitée
    /// aux sites déclarés.
    /// </summary>
    private static string? PageOrigin(HttpRequest request)
    {
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        if (site.Length > 0 && site != "same-origin") return null;
        if (Uri.TryCreate(request.Headers.Referer.ToString(), UriKind.Absolute, out var page) && page.Scheme is "http" or "https")
            return page.GetLeftPart(UriPartial.Authority);
        return site.Length > 0 ? $"{request.Scheme}://{request.Host}" : null;
    }
}
