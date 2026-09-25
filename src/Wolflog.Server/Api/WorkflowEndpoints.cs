using System.Globalization;
using System.Text;
using System.Text.Json;
using Wolflog.Server.Configuration;
using Wolflog.Server.Query;
using Wolflog.Server.Security;
using static Wolflog.Server.Api.ApiEndpoints;

namespace Wolflog.Server.Api;

/// <summary>Travail au quotidien : suivi des erreurs, déploiements, recherches enregistrées, export.</summary>
public static class WorkflowEndpoints
{
    public sealed record StateInput(string? Status, string? AssignedTo, bool? Unassign, string? Note);
    public sealed record BulkStateInput(List<string>? Fingerprints, string? Status);
    public sealed record DeploymentInput(string? Service, string? Env, string? Version, string? Description, DateTime? At);
    public sealed record SavedSearchInput(string? Name, string? Page, Dictionary<string, string>? Params, bool? Shared);

    public static List<ErrorGroup> WithStatus(IEnumerable<ErrorGroup> groups, ErrorStateStore states)
    {
        var map = states.Map();
        return groups.Select(g =>
        {
            map.TryGetValue(g.Fingerprint, out var s);
            return g with { Status = ErrorStatus.Effective(s, g.LastSeen), AssignedTo = s?.AssignedTo };
        }).ToList();
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    extension(WebApplication app)
    {
        public void MapWolflogWorkflow(RouteGroupBuilder api, RouteGroupBuilder editor)
        {
            var auth = app.Services.GetRequiredService<AuthService>();

            // ------------------------------------------------------------ statut des erreurs
            editor.MapPost("/errors/{fingerprint}/state", (string fingerprint, StateInput body, HttpContext ctx, ErrorStateStore states) =>
            {
                var state = states.Apply(fingerprint, body.Status, body.AssignedTo, body.Note, body.Unassign == true, ctx.User.Identity?.Name);
                return Results.Ok(state);
            });

            editor.MapPost("/errors/state", (BulkStateInput body, HttpContext ctx, ErrorStateStore states) =>
            {
                foreach (var fp in body.Fingerprints ?? [])
                    states.Apply(fp, body.Status, null, null, false, ctx.User.Identity?.Name);
                return Results.Ok();
            });

            // Personnes à qui assigner une erreur.
            api.MapGet("/people", () => Results.Ok(auth.Users.All().Where(u => !u.Disabled).OrderBy(u => u.DisplayName ?? u.Username)
                .Select(u => new { u.Username, displayName = u.DisplayName ?? u.Username })));

            // ------------------------------------------------------------ déploiements
            api.MapGet("/deployments", (HttpContext ctx, DeploymentStore store) =>
            {
                var (from, to) = Range(ctx);
                var env = Str(ctx, "env");
                var services = Str(ctx, "service")?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                var list = store.All()
                    .Where(d => d.At >= from && d.At <= to && d.Source != "initial")
                    .Where(d => env is null || d.Env == env)
                    .Where(d => services is null || services.Contains(d.Service))
                    .OrderByDescending(d => d.At)
                    .Take(Int(ctx, "limit", 200));
                return Results.Ok(list);
            });

            editor.MapPost("/deployments", (DeploymentInput body, HttpContext ctx, DeploymentStore store) =>
                Declare(body, ctx.User.Identity?.Name, store));

            editor.MapDelete("/deployments/{id}", (string id, DeploymentStore store) =>
                store.Delete(id) ? Results.Ok() : Results.NotFound());

            // Déclaration depuis l'intégration continue, avec une clé d'ingestion (contrôlée par le middleware /v1).
            app.MapPost("/v1/deployments", (DeploymentInput body, DeploymentStore store) => Declare(body, "ci", store)).AllowAnonymous();

            // ------------------------------------------------------------ recherches enregistrées
            api.MapGet("/searches", (HttpContext ctx, SavedSearchStore store) =>
            {
                var me = ctx.User.Identity?.Name;
                var page = Str(ctx, "page");
                return Results.Ok(store.All()
                    .Where(s => s.Shared || s.Owner == me || !auth.Enabled)
                    .Where(s => page is null || s.Page == page)
                    .OrderBy(s => s.Page).ThenBy(s => s.Name, StringComparer.CurrentCultureIgnoreCase)
                    .Select(s => new { s.Id, s.Name, s.Page, s.Params, s.Owner, s.Shared, mine = s.Owner == me || !auth.Enabled }));
            });

            api.MapPost("/searches", (SavedSearchInput body, HttpContext ctx, SavedSearchStore store) =>
            {
                if (string.IsNullOrWhiteSpace(body.Name)) return Results.BadRequest(new { error = "Donnez un nom à la recherche." });
                if (body.Page is not ("logs" or "requests" or "traces" or "errors")) return Results.BadRequest(new { error = "Page inconnue." });
                var shared = body.Shared == true && (!auth.Enabled || Roles.Allows(ctx.User.Role(), Roles.Editor));
                var saved = store.Upsert(new SavedSearch
                {
                    Name = body.Name.Trim(),
                    Page = body.Page,
                    Params = (body.Params ?? []).Where(p => !string.IsNullOrWhiteSpace(p.Value)).ToDictionary(),
                    Owner = ctx.User.Identity?.Name,
                    Shared = shared,
                });
                return Results.Ok(saved);
            });

            api.MapDelete("/searches/{id}", (string id, HttpContext ctx, SavedSearchStore store) =>
            {
                var s = store.Get(id);
                if (s is null) return Results.NotFound();
                var allowed = !auth.Enabled || s.Owner == ctx.User.Identity?.Name || Roles.Allows(ctx.User.Role(), Roles.Admin);
                if (!allowed) return Results.Forbid();
                store.Delete(id);
                return Results.Ok();
            });

            // ------------------------------------------------------------ export
            api.MapGet("/logs/export", async (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var q = Search(ctx);
                var max = Math.Clamp(Int(ctx, "limit", 10_000), 1, 200_000);
                var csv = Str(ctx, "format") != "json";
                Download(ctx, "logs", csv);
                await using var w = new StreamWriter(ctx.Response.Body, new UTF8Encoding(csv));
                if (csv) await w.WriteLineAsync("horodatage;niveau;service;environnement;hôte;version;catégorie;message;exception;trace_id;span_id;attributs");
                else await w.WriteAsync('[');
                DateTime? before = null;
                var written = 0;
                while (written < max && !ctx.RequestAborted.IsCancellationRequested)
                {
                    var page = qs.SearchLogs(from, to, q, Math.Min(5000, max - written), before, ctx.RequestAborted);
                    foreach (var l in page.Items)
                    {
                        if (csv)
                            await w.WriteLineAsync(Csv(l.Ts.ToString("O"), l.Level, l.Service, l.Env, l.Host, l.Version, l.Category, l.Body,
                                l.ExceptionType is null ? null : $"{l.ExceptionType}: {l.ExceptionMessage}", l.TraceId, l.SpanId, l.Attributes));
                        else
                        {
                            if (written > 0) await w.WriteAsync(',');
                            await w.WriteAsync(JsonSerializer.Serialize(Plain(l), Json));
                        }
                        written++;
                    }
                    if (page.NextBefore is null) break;
                    before = page.NextBefore;
                    await w.FlushAsync();
                }
                if (!csv) await w.WriteAsync(']');
            });

            api.MapGet("/requests/export", async (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var items = qs.HttpRequests(from, to, Http(ctx), Math.Clamp(Int(ctx, "limit", 10_000), 1, 50_000), ctx.RequestAborted, maxLimit: 50_000);
                var csv = Str(ctx, "format") != "json";
                Download(ctx, "requetes-http", csv);
                await using var w = new StreamWriter(ctx.Response.Body, new UTF8Encoding(csv));
                if (!csv)
                {
                    await JsonSerializer.SerializeAsync(ctx.Response.Body, items, Json, ctx.RequestAborted);
                    return;
                }
                await w.WriteLineAsync("horodatage;service;méthode;route;cible;statut;durée_ms;erreur;trace_id;span_id");
                foreach (var r in items)
                    await w.WriteLineAsync(Csv(r.Ts.ToString("O"), r.Service, r.Method, r.Route, r.Target, r.Status?.ToString(CultureInfo.InvariantCulture),
                        r.DurationMs.ToString("0.###", French.Numbers), r.Error ? "oui" : "non", r.TraceId, r.SpanId));
            });
        }
    }

    private static IResult Declare(DeploymentInput body, string? by, DeploymentStore store)
    {
        if (string.IsNullOrWhiteSpace(body.Service) || string.IsNullOrWhiteSpace(body.Version))
            return Results.BadRequest(new { error = "service et version sont requis." });
        var at = body.At is { } a ? DateTime.SpecifyKind(a.ToUniversalTime(), DateTimeKind.Utc) : (DateTime?)null;
        return Results.Ok(store.Declare(body.Service.Trim(), string.IsNullOrWhiteSpace(body.Env) ? null : body.Env.Trim(), body.Version.Trim(),
            body.Description, by, at));
    }

    private static void Download(HttpContext ctx, string name, bool csv)
    {
        var file = $"wolflog-{name}-{DateTime.Now:yyyyMMdd-HHmm}.{(csv ? "csv" : "json")}";
        ctx.Response.ContentType = csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{file}\"";
    }

    private static object Plain(LogItem l) => new
    {
        l.Ts, l.Level, l.Service, l.Env, l.Host, l.Version, l.Category, message = l.Body,
        exception = l.ExceptionType is null ? null : new { type = l.ExceptionType, message = l.ExceptionMessage, stack = l.ExceptionStack },
        l.TraceId, l.SpanId,
        attributes = JsonSerializer.Deserialize<JsonElement>(string.IsNullOrEmpty(l.Attributes) ? "{}" : l.Attributes),
    };

    /// <summary>Ligne CSV au format attendu par Excel en français (séparateur point-virgule, BOM UTF-8).</summary>
    internal static string Csv(params string?[] values)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < values.Length; i++)
        {
            if (i > 0) sb.Append(';');
            var v = values[i];
            if (string.IsNullOrEmpty(v)) continue;
            if (v[0] is '=' or '+' or '@') v = "'" + v; // pas de formule interprétée par le tableur
            if (v.AsSpan().IndexOfAny(";\"\r\n") >= 0) sb.Append('"').Append(v.Replace("\"", "\"\"")).Append('"');
            else sb.Append(v);
        }
        return sb.ToString();
    }
}
