namespace Wolflog.Server.Api;

/// <summary>
/// Carte de chaleur affichée sur le site lui-même (« Ouvrir sur le site »), pour les pages protégées par une connexion :
/// dans l'aperçu de Wolflog, le navigateur n'envoie pas la session du site à une iframe d'un autre site.
/// La page /_wolflog/heatmap du site (Wolflog.Client.Blazor, ou une page statique) charge /wolflog-heatmap.js, qui affiche
/// les pages du site avec la session de la personne et lit ici leurs clics avec un jeton (Authorization: Bearer), sans cookie.
/// </summary>
public static class HeatmapEndpoints
{
    private const string GrantKey = "wolflog.heatmap-viewer";
    private static readonly byte[] Script = LoadScript();

    private static byte[] LoadScript()
    {
        using var s = typeof(HeatmapEndpoints).Assembly.GetManifestResourceStream("wolflog-heatmap.js");
        if (s is null) return "/* wolflog-heatmap.js absent de cette version */"u8.ToArray();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    extension(WebApplication app)
    {
        public void MapWolflogHeatmapViewer()
        {
            app.MapGet("/wolflog-heatmap.js", (HttpContext ctx) =>
            {
                ctx.Response.Headers.CacheControl = "public, max-age=600";
                ctx.Response.Headers.AccessControlAllowOrigin = "*";
                return Results.Bytes(Script, "application/javascript; charset=utf-8");
            }).AllowAnonymous();

            // Requête préalable CORS : l'en-tête Authorization n'est pas « simple ».
            app.MapMethods("/api/heatmap/{**rest}", ["OPTIONS"], (HttpContext ctx) =>
            {
                Cors(ctx);
                ctx.Response.Headers.AccessControlAllowMethods = "GET";
                ctx.Response.Headers.AccessControlAllowHeaders = "authorization";
                ctx.Response.Headers.AccessControlMaxAge = "86400";
                return Results.NoContent();
            }).AllowAnonymous();

            // Ni session ni profil d'accès : le jeton porte le service, les services visibles et l'environnement de la personne.
            var g = app.MapGroup("/api/heatmap").AllowAnonymous();
            g.AddEndpointFilter(async (ictx, next) =>
            {
                var ctx = ictx.HttpContext;
                Cors(ctx);
                var header = ctx.Request.Headers.Authorization.ToString();
                var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..].Trim() : null;
                if (ctx.RequestServices.GetRequiredService<HeatmapViewerTokens>().Read(token) is not { } grant)
                    return Results.Json(new { error = "Lien expiré ou invalide : rouvrez la carte depuis Wolflog." }, statusCode: StatusCodes.Status401Unauthorized);
                var qs = ctx.RequestServices.GetRequiredService<QueryService>();
                qs.Env = grant.Env;
                if (grant.Services.Count > 0) qs.Scope = new ServiceScope(grant.Services);
                ctx.Items[GrantKey] = grant;
                return await next(ictx);
            });

            // Pages ayant des clics (liste de la barre), et ce que couvre le jeton.
            g.MapGet("/pages", (HttpContext ctx, QueryService qs, string? device) =>
            {
                var grant = Grant(ctx);
                var (from, to) = grant.Range(DateTime.UtcNow);
                return Results.Ok(new
                {
                    grant.Service, grant.Env, from, to, grant.Live,
                    pages = qs.ClickmapPages(from, to, new AnalyticsFilter { Service = grant.Service }, Device(device), ctx.RequestAborted),
                });
            });

            g.MapGet("/clickmap", (HttpContext ctx, QueryService qs, string path, string? device) =>
            {
                var grant = Grant(ctx);
                var (from, to) = grant.Range(DateTime.UtcNow);
                return Results.Ok(qs.Clickmap(from, to, new AnalyticsFilter { Service = grant.Service }, path, Device(device), ctx.RequestAborted));
            });
        }
    }

    private static HeatmapViewerGrant Grant(HttpContext ctx) => (HeatmapViewerGrant)ctx.Items[GrantKey]!;

    private static string? Device(string? device) => device is "desktop" or "tablet" or "mobile" ? device : null;

    private static void Cors(HttpContext ctx)
    {
        var origin = ctx.Request.Headers.Origin.ToString();
        ctx.Response.Headers.AccessControlAllowOrigin = string.IsNullOrEmpty(origin) ? "*" : origin;
        ctx.Response.Headers.Vary = "Origin";
    }
}
