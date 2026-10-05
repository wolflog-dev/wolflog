namespace Wolflog.Server.Api;

/// <summary>
/// Audience web : réception côté serveur (/v1/analytics, clé serveur) et lecture pour l'interface (/api/analytics/*).
/// Filtres communs : <c>service</c>, <c>f.&lt;dimension&gt;</c> (page, referrer, country…), plage <c>from</c>/<c>to</c>.
/// </summary>
public static class AnalyticsEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    extension(WebApplication app)
    {
        public void MapWolflogAnalytics(RouteGroupBuilder api)
        {
            // Envoi par une application (Wolflog.Client.Blazor…) : la clé serveur est vérifiée par IngestKeyMiddleware.
            app.MapPost("/v1/analytics", async (HttpContext ctx, AnalyticsCollector collector) =>
            {
                if (ctx.Request.ContentLength > 1024 * 1024) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                ServerAnalyticsBatch? batch;
                try { batch = await JsonSerializer.DeserializeAsync<ServerAnalyticsBatch>(ctx.Request.Body, Json, ctx.RequestAborted); }
                catch (JsonException) { return Results.BadRequest(); }
                if (batch is null) return Results.BadRequest();
                await collector.StoreAsync(collector.FromServer(batch, ctx), ctx.RequestAborted);
                return Results.Accepted();
            }).AllowAnonymous();

            var group = api.MapGroup("/analytics");

            group.MapGet("/summary", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                return Results.Ok(qs.AnalyticsSummary(from, to, AnalyticsFilter.From(ctx.Request.Query), ctx.RequestAborted));
            });

            group.MapGet("/series", (HttpContext ctx, QueryService qs, bool? compare) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                return Results.Ok(qs.AnalyticsSeries(from, to, AnalyticsFilter.From(ctx.Request.Query), compare == true, ctx.RequestAborted));
            });

            group.MapGet("/breakdown", (HttpContext ctx, QueryService qs, string dimension, int? limit) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                return Results.Ok(qs.AnalyticsBreakdown(from, to, AnalyticsFilter.From(ctx.Request.Query), dimension, limit ?? 10, ctx.RequestAborted));
            });

            group.MapGet("/events/{name}/properties", (HttpContext ctx, QueryService qs, string name) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                return Results.Ok(qs.AnalyticsEventProperties(from, to, AnalyticsFilter.From(ctx.Request.Query), name, ctx.RequestAborted));
            });

            group.MapGet("/realtime", (HttpContext ctx, QueryService qs) =>
                Results.Ok(qs.AnalyticsRealtime(AnalyticsFilter.From(ctx.Request.Query), ctx.RequestAborted)));

            group.MapGet("/funnel", (HttpContext ctx, QueryService qs, string steps, int? window) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                List<AnalyticsFunnelStep>? parsed;
                try { parsed = JsonSerializer.Deserialize<List<AnalyticsFunnelStep>>(steps, Json); }
                catch (JsonException) { return Results.BadRequest(); }
                return Results.Ok(qs.AnalyticsFunnel(from, to, AnalyticsFilter.From(ctx.Request.Query), parsed ?? [], window ?? 60, ctx.RequestAborted));
            });

            group.MapGet("/clickmaps", (HttpContext ctx, QueryService qs, string? device) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                return Results.Ok(qs.ClickmapPages(from, to, AnalyticsFilter.From(ctx.Request.Query), device, ctx.RequestAborted));
            });

            group.MapGet("/clickmap", (HttpContext ctx, QueryService qs, string path, string? device) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                return Results.Ok(qs.Clickmap(from, to, AnalyticsFilter.From(ctx.Request.Query), path, device, ctx.RequestAborted));
            });

            group.MapGet("/frustrations", (HttpContext ctx, QueryService qs, string? device) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                return Results.Ok(qs.ClickmapFrustrations(from, to, AnalyticsFilter.From(ctx.Request.Query), device, ctx.RequestAborted));
            });

            // « Ouvrir sur le site » : jeton de lecture des clics pour la page /_wolflog/heatmap du site (voir HeatmapEndpoints),
            // limité au service choisi (sinon aux services visibles de la personne), à l'environnement et à la période en cours.
            group.MapPost("/clickmap/viewer", (HttpContext ctx, QueryService qs, HeatmapViewerTokens tokens) =>
            {
                var (from, to) = ApiEndpoints.Range(ctx);
                var service = ctx.Request.Query["service"].ToString() is { Length: > 0 } s ? s : null;
                var visible = ctx.VisibleServices;
                if (service is not null && !visible.Allows(service)) return Results.NotFound();
                var live = string.IsNullOrEmpty(ctx.Request.Query["to"]);
                var grant = new HeatmapViewerGrant(service, visible.Patterns, qs.Env, from, to, live, ctx.User.Identity?.Name);
                return Results.Ok(new { token = tokens.Issue(grant), expiresAt = DateTime.UtcNow + HeatmapViewerTokens.Lifetime });
            });
        }
    }
}
