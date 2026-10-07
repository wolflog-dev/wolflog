using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Hosting;

namespace Wolflog.Client.Blazor;

/// <summary>
/// Relais par le site, sous /_wolflog : le navigateur ne s'adresse qu'au site, qui joint Wolflog côté serveur. Rien n'est donc
/// bloqué comme « contenu mixte » (site en HTTPS, Wolflog en HTTP sur une adresse IP) ni par un certificat que le navigateur ne
/// connaît pas, ni par un bloqueur de publicité.
/// <list type="bullet">
/// <item>/_wolflog/wolflog-rum.js : script navigateur, copie embarquée dans ce paquet : le chargement des pages ne dépend jamais
/// de Wolflog. Ses envois (/v1/rum, captures de page) passent par le site ;</item>
/// <item>/_wolflog/heatmap : carte de chaleur affichée sur le site (« Ouvrir sur le site »), son script et ses clics.</item>
/// </list>
/// Seules ces routes sont relayées, vers le serveur Wolflog configuré. Wolflog injoignable ou trop lent : après un délai court,
/// le site répond 503 aussitôt pendant 30 secondes, sans plus le solliciter. Les pages d'erreur de l'application ne
/// s'appliquent jamais à ces réponses.
/// </summary>
internal static class SiteRelay
{
    public const string Prefix = "/_wolflog";
    private const long MaxBody = 3 * 1024 * 1024;
    /// <summary>Délai d'un envoi du script ; la carte sur le site, ouverte par une personne, attend un peu plus.</summary>
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ViewerTimeout = TimeSpan.FromSeconds(15);
    /// <summary>Pause après un échec : Wolflog n'est plus sollicité, le site répond 503 aussitôt.</summary>
    private static readonly TimeSpan Pause = TimeSpan.FromSeconds(30);
    private static readonly HttpClient Shared = new() { Timeout = ViewerTimeout };
    /// <summary>Fin de la pause, par serveur Wolflog (ticks UTC).</summary>
    private static readonly ConcurrentDictionary<string, long> PausedUntil = new(StringComparer.OrdinalIgnoreCase);
    private static readonly byte[] RumScript = LoadScript();
    private static readonly string RumETag = $"\"{Convert.ToHexString(SHA256.HashData(RumScript))[..16]}\"";
    /// <summary>En-têtes du visiteur utiles à Wolflog : site d'origine (clé navigateur), navigateur, langue, pays (CDN).</summary>
    private static readonly string[] VisitorHeaders =
        ["Origin", "User-Agent", "Accept-Language", "cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code", "x-appengine-country"];

    /// <summary>Route relayée : script et clics de la carte sur le site, ou envoi du script navigateur.</summary>
    private enum Route
    {
        Viewer,
        ViewerApi,
        Visitor,
    }

    /// <summary>Répond à la requête si elle est l'une des routes du relais ; false sinon (la requête continue).</summary>
    public static async Task<bool> TryHandleAsync(HttpContext ctx, Uri wolflog)
    {
        if (!ctx.Request.Path.StartsWithSegments(Prefix, StringComparison.OrdinalIgnoreCase, out var rest)) return false;
        var path = (rest.Value ?? "").ToLowerInvariant();
        var server = wolflog.AbsoluteUri.TrimEnd('/');
        var query = ctx.Request.QueryString.Value;
        var get = HttpMethods.IsGet(ctx.Request.Method);
        var post = HttpMethods.IsPost(ctx.Request.Method);
        Func<Task>? handle = path switch
        {
            "/wolflog-rum.js" when get => () => WriteScript(ctx),
            "/heatmap" when get => () => WritePage(ctx),
            "/heatmap.js" when get => () => RelayAsync(ctx, server, $"{server}/wolflog-heatmap.js", Route.Viewer),
            "/api/heatmap/pages" or "/api/heatmap/clickmap" when get => () => RelayAsync(ctx, server, $"{server}{path}{query}", Route.ViewerApi),
            "/v1/rum" when post => () => RelayAsync(ctx, server, $"{server}{path}{query}", Route.Visitor),
            "/v1/rum/snapshot" when get || post => () => RelayAsync(ctx, server, $"{server}{path}{query}", Route.Visitor),
            _ => null,
        };
        if (handle is null) return false;
        // Réponses du relais telles quelles : une erreur venue de Wolflog (401, 413…) ne devient pas la page d'erreur de l'application.
        if (ctx.Features.Get<IStatusCodePagesFeature>() is { } statusPages) statusPages.Enabled = false;
        await handle();
        return true;
    }

    /// <summary>Script navigateur embarqué (même version que ce paquet) : servi sans appeler Wolflog, gardé une heure en cache.</summary>
    private static Task WriteScript(HttpContext ctx)
    {
        var headers = ctx.Response.Headers;
        headers.CacheControl = "public, max-age=3600";
        headers.ETag = RumETag;
        headers.XContentTypeOptions = "nosniff";
        if (ctx.Request.Headers.IfNoneMatch.Any(tag => tag?.Contains(RumETag, StringComparison.Ordinal) == true))
        {
            ctx.Response.StatusCode = StatusCodes.Status304NotModified;
            return Task.CompletedTask;
        }
        ctx.Response.ContentType = "application/javascript; charset=utf-8";
        ctx.Response.ContentLength = RumScript.Length;
        return ctx.Response.Body.WriteAsync(RumScript, ctx.RequestAborted).AsTask();
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
    /// Relaie la requête vers Wolflog et recopie la réponse. Envoi du script : accompagné de l'adresse IP du visiteur
    /// (X-Forwarded-For, pour l'empreinte anonyme) et de ses en-têtes utiles. Authorization : seulement pour lire les clics de la
    /// carte sur le site (jeton du lien), jamais les identifiants du visiteur auprès du site (Basic, Bearer, Negotiate).
    /// </summary>
    private static async Task RelayAsync(HttpContext ctx, string server, string url, Route route)
    {
        if (PausedUntil.TryGetValue(server, out var until) && DateTime.UtcNow.Ticks < until)
        {
            await Fail(ctx, StatusCodes.Status503ServiceUnavailable, "Wolflog est injoignable depuis le site : nouvel essai dans quelques secondes.");
            return;
        }
        var client = ctx.RequestServices.GetService<IHttpClientFactory>()?.CreateClient(WolflogBlazorExtensions.HttpClientName) ?? Shared;
        using var request = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), url);
        if (HttpMethods.IsPost(ctx.Request.Method))
        {
            // Corps lu en entier avant d'appeler Wolflog : un visiteur lent ne compte pas dans le délai accordé à Wolflog.
            if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit) limit.MaxRequestBodySize = MaxBody;
            var body = new MemoryStream();
            try
            {
                if (ctx.Request.ContentLength > MaxBody) throw new BadHttpRequestException("Corps trop volumineux.", StatusCodes.Status413PayloadTooLarge);
                await ctx.Request.Body.CopyToAsync(body, ctx.RequestAborted);
                if (body.Length > MaxBody) throw new BadHttpRequestException("Corps trop volumineux.", StatusCodes.Status413PayloadTooLarge);
            }
            catch (BadHttpRequestException ex)
            {
                await body.DisposeAsync();
                ctx.Response.StatusCode = ex.StatusCode;
                return;
            }
            body.Position = 0;
            request.Content = new StreamContent(body);
            request.Content.Headers.TryAddWithoutValidation("Content-Type", ctx.Request.ContentType ?? "text/plain");
        }
        if (route == Route.ViewerApi && ctx.Request.Headers.Authorization.ToString() is { Length: > 0 } authorization)
            request.Headers.TryAddWithoutValidation("Authorization", authorization);
        if (route == Route.Visitor)
        {
            foreach (var name in VisitorHeaders)
                if (ctx.Request.Headers[name].ToString() is { Length: > 0 } value) request.Headers.TryAddWithoutValidation(name, value);
            if (ctx.Request.Headers.Origin.ToString().Length == 0 && PageOrigin(ctx.Request) is { } origin)
                request.Headers.TryAddWithoutValidation("Origin", origin);
            var forwarded = ctx.Request.Headers["X-Forwarded-For"].ToString();
            var ip = forwarded.Length > 0 ? forwarded.Split(',')[0].Trim() : ctx.Connection.RemoteIpAddress?.ToString();
            if (!string.IsNullOrEmpty(ip)) request.Headers.TryAddWithoutValidation("X-Forwarded-For", ip);
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
        timeout.CancelAfter(route == Route.Visitor ? SendTimeout : ViewerTimeout);
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            PausedUntil.TryRemove(server, out _);
            ctx.Response.StatusCode = (int)response.StatusCode;
            if (response.Content.Headers.ContentType is { } type) ctx.Response.ContentType = type.ToString();
            ctx.Response.Headers.CacheControl = response.Headers.CacheControl?.ToString() ?? "no-store";
            await response.Content.CopyToAsync(ctx.Response.Body, timeout.Token);
        }
        catch (Exception ex) when ((ex is HttpRequestException || (ex is OperationCanceledException && !ctx.RequestAborted.IsCancellationRequested)) && !ctx.Response.HasStarted)
        {
            // Wolflog injoignable ou trop lent : pause, pendant laquelle le site répond aussitôt (adresse de Wolflog jamais montrée).
            PausedUntil[server] = (DateTime.UtcNow + Pause).Ticks;
            await Fail(ctx, StatusCodes.Status502BadGateway, "Le site n'arrive pas à joindre Wolflog : vérifiez Wolflog:Endpoint dans sa configuration.");
        }
    }

    private static Task Fail(HttpContext ctx, int status, string error)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.Headers.CacheControl = "no-store";
        if (status == StatusCodes.Status503ServiceUnavailable) ctx.Response.Headers.RetryAfter = ((int)Pause.TotalSeconds).ToString(CultureInfo.InvariantCulture);
        return ctx.Response.WriteAsJsonAsync(new { error });
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

    private static byte[] LoadScript()
    {
        using var stream = typeof(SiteRelay).Assembly.GetManifestResourceStream("wolflog-rum.js");
        if (stream is null) return "/* wolflog-rum.js absent de ce paquet */"u8.ToArray();
        using var copy = new MemoryStream();
        stream.CopyTo(copy);
        return copy.ToArray();
    }
}
