using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Vigil.Server.Query;
using Vigil.Server.Security;
using Vigil.Server.Storage;

namespace Vigil.Server.Api;

public static class ApiEndpoints
{
    public sealed record LoginRequest(string? Username, string? Password);

    extension(WebApplication app)
    {
        public void MapVigilApi()
        {
            var auth = app.Services.GetRequiredService<AuthService>();

            app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();

            // ------------------------------------------------------------ authentification
            var authGroup = app.MapGroup("/api/auth").AllowAnonymous();
            authGroup.MapGet("/me", (HttpContext ctx) => Results.Ok(new
            {
                authEnabled = auth.Enabled,
                authenticated = !auth.Enabled || ctx.User.Identity?.IsAuthenticated == true,
                user = auth.Enabled ? ctx.User.Identity?.Name : "local",
            }));
            authGroup.MapPost("/login", async (HttpContext ctx, LoginRequest body) =>
            {
                if (!auth.Enabled) return Results.Ok();
                if (!auth.ValidateUser(body.Username, body.Password))
                {
                    await Task.Delay(Random.Shared.Next(300, 600)); // ralentit le brute force
                    return Results.Unauthorized();
                }
                var identity = new ClaimsIdentity([new Claim(ClaimTypes.Name, body.Username!)], CookieAuthenticationDefaults.AuthenticationScheme);
                await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity),
                    new AuthenticationProperties { IsPersistent = true });
                return Results.Ok();
            });
            authGroup.MapPost("/logout", async (HttpContext ctx) =>
            {
                await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                return Results.Ok();
            });

            var api = app.MapGroup("/api");
            if (auth.Enabled) api.RequireAuthorization();

            // Environnement sélectionné dans l'interface : appliqué à toutes les requêtes de lecture.
            api.AddEndpointFilter(async (ictx, next) =>
            {
                var env = ictx.HttpContext.Request.Query["env"].ToString();
                if (!string.IsNullOrWhiteSpace(env))
                    ictx.HttpContext.RequestServices.GetRequiredService<QueryService>().Env = env;
                return await next(ictx);
            });

            // ------------------------------------------------------------ logs
            api.MapGet("/logs", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var q = Search(ctx);
                var limit = Int(ctx, "limit", 200);
                var before = Date(ctx, "before");
                return Results.Ok(qs.SearchLogs(from, to, q, limit, before, ctx.RequestAborted));
            });

            api.MapGet("/logs/histogram", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.LogHistogram(from, to, Search(ctx), ctx.RequestAborted));
            });

            api.MapGet("/logs/tail", async (HttpContext ctx, StorageHost storage) =>
            {
                var q = Search(ctx);
                if (Str(ctx, "env") is { } tailEnv) q.Columns.Add(("env", tailEnv));
                ctx.Response.Headers.ContentType = "text/event-stream";
                ctx.Response.Headers.CacheControl = "no-cache";
                ctx.Response.Headers["X-Accel-Buffering"] = "no";
                ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();

                using var sub = storage.Tail.Subscribe(q.Matches);
                var reader = sub.Channel.Reader;
                var ct = ctx.RequestAborted;
                var batch = new List<LogItem>(200);
                await ctx.Response.WriteAsync(": connected\n\n", ct);
                await ctx.Response.Body.FlushAsync(ct);
                try
                {
                    while (!ct.IsCancellationRequested)
                    {
                        using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(ct);
                        heartbeat.CancelAfter(TimeSpan.FromSeconds(15));
                        bool ready;
                        try { ready = await reader.WaitToReadAsync(heartbeat.Token); }
                        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                        {
                            await ctx.Response.WriteAsync(": ping\n\n", ct);
                            await ctx.Response.Body.FlushAsync(ct);
                            continue;
                        }
                        if (!ready) break;

                        batch.Clear();
                        while (batch.Count < 200 && reader.TryRead(out var row)) batch.Add(ToItem(row));
                        await ctx.Response.WriteAsync("data: " + JsonSerializer.Serialize(batch, JsonOptions) + "\n\n", ct);
                        await ctx.Response.Body.FlushAsync(ct);
                    }
                }
                catch (OperationCanceledException) { }
            });

            // ------------------------------------------------------------ traces
            api.MapGet("/traces", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                double? minMs = double.TryParse(ctx.Request.Query["minMs"], CultureInfo.InvariantCulture, out var m) ? m : null;
                return Results.Ok(qs.SearchTraces(from, to, Str(ctx, "service"), Str(ctx, "q"), minMs,
                    Str(ctx, "errors") is "true" or "1", Int(ctx, "limit", 200), ctx.RequestAborted));
            });

            api.MapGet("/traces/{traceId}", (string traceId, HttpContext ctx, QueryService qs) =>
                Results.Ok(qs.GetTrace(traceId, Date(ctx, "around"), ctx.RequestAborted)));

            // ------------------------------------------------------------ erreurs / crashs
            api.MapGet("/errors", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.Errors(from, to, Search(ctx), Int(ctx, "limit", 200), ctx.RequestAborted));
            });

            api.MapGet("/errors/{fingerprint}", (string fingerprint, HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var detail = qs.ErrorDetail(fingerprint, from, to, ctx.RequestAborted);
                return detail is null ? Results.NotFound() : Results.Ok(detail);
            });

            // ------------------------------------------------------------ métriques
            api.MapGet("/metrics", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.MetricNames(from, to, Str(ctx, "service"), ctx.RequestAborted));
            });

            api.MapGet("/metrics/keys", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var name = Str(ctx, "name");
                return name is null ? Results.BadRequest("name requis") : Results.Ok(qs.MetricAttributeKeys(name, from, to, ctx.RequestAborted));
            });

            api.MapGet("/metrics/series", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var name = Str(ctx, "name");
                if (name is null) return Results.BadRequest("name requis");
                return Results.Ok(qs.MetricSeries(name, from, to, Str(ctx, "service"), Str(ctx, "groupBy"), Str(ctx, "stat"), ctx.RequestAborted));
            });

            // ------------------------------------------------------------ requêtes HTTP
            api.MapGet("/requests", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.HttpRequests(from, to, Http(ctx), Int(ctx, "limit", 300), ctx.RequestAborted));
            });

            api.MapGet("/requests/summary", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.HttpSummary(from, to, Http(ctx), ctx.RequestAborted));
            });

            api.MapGet("/requests/series", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.HttpSeries(from, to, Http(ctx), Str(ctx, "stat"), Str(ctx, "groupBy"), ctx.RequestAborted));
            });

            api.MapGet("/environments", (HttpContext ctx, QueryService qs) =>
            {
                qs.Env = null;
                return Results.Ok(qs.Environments(ctx.RequestAborted));
            });

            // ------------------------------------------------------------ requêtes personnalisées
            api.MapGet("/query", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var cq = new CustomQuery(Str(ctx, "source") ?? "logs", Str(ctx, "filter"), Str(ctx, "agg") ?? "count", Str(ctx, "field"),
                    Str(ctx, "groupBy"), Str(ctx, "view") ?? "timeseries", Int(ctx, "limit", 10), Str(ctx, "service"));
                try { return Results.Ok(qs.Custom(cq, from, to, ctx.RequestAborted)); }
                catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
            });

            api.MapGet("/fields", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.Fields(Str(ctx, "source"), from, to, ctx.RequestAborted));
            });

            api.MapGet("/fields/values", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var key = Str(ctx, "key");
                return key is null ? Results.BadRequest("key requis") : Results.Ok(qs.FieldValues(Str(ctx, "source"), key, from, to, ctx.RequestAborted));
            });

            // ------------------------------------------------------------ tableaux de bord
            api.MapGet("/dashboards", (Dashboards.DashboardStore store) =>
                Results.Ok(store.All().Select(d => new { d.Id, d.Name, d.Description, Panels = d.Panels.Count, d.UpdatedAt })));
            api.MapGet("/dashboards/{id}", (string id, Dashboards.DashboardStore store) =>
                store.Get(id) is { } d ? Results.Ok(d) : Results.NotFound());
            api.MapPost("/dashboards", (Dashboards.Dashboard body, Dashboards.DashboardStore store) =>
            {
                body.Id = Guid.NewGuid().ToString("N")[..10];
                return Results.Ok(store.Upsert(body));
            });
            api.MapPut("/dashboards/{id}", (string id, Dashboards.Dashboard body, Dashboards.DashboardStore store) =>
            {
                body.Id = id;
                return Results.Ok(store.Upsert(body));
            });
            api.MapDelete("/dashboards/{id}", (string id, Dashboards.DashboardStore store) =>
                store.Delete(id) ? Results.Ok() : Results.NotFound());

            // ------------------------------------------------------------ vue d'ensemble / système
            api.MapGet("/services", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.Services(from, to, ctx.RequestAborted));
            });

            api.MapGet("/overview", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.Overview(from, to, ctx.RequestAborted));
            });

            api.MapGet("/system", (QueryService qs) => Results.Ok(qs.Stats()));

            api.MapGet("/system/integration", (HttpContext ctx) => Results.Ok(new
            {
                endpoint = $"{ctx.Request.Scheme}://{ctx.Request.Host}",
                apiKey = auth.Enabled ? auth.PrimaryApiKey : null,
                authEnabled = auth.Enabled,
            }));

            api.MapPost("/system/flush", async (StorageHost storage) =>
            {
                await Task.WhenAll(storage.All.Select(s => s.FlushAsync()));
                return Results.Ok();
            });

            api.MapPost("/system/compact", async (StorageHost storage) =>
            {
                foreach (var s in storage.All)
                {
                    await s.FlushAsync();
                    await s.CompactAsync(force: true);
                }
                return Results.Ok();
            });
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static LogItem ToItem(LogRow r) => new(
        DateTime.SpecifyKind(r.Ts, DateTimeKind.Utc), r.Service, r.Host, r.Env, r.Version, r.Severity, SearchQuery.SeverityToLevel(r.Severity),
        r.Body, r.TraceId, r.SpanId, r.Category, r.ExceptionType, r.ExceptionMessage, r.ExceptionStack, r.Fingerprint, r.IsCrash,
        r.Attributes, r.Resource);

    // ------------------------------------------------------------ paramètres

    private static SearchQuery Search(HttpContext ctx)
    {
        var q = SearchQuery.Parse(ctx.Request.Query["q"]);
        foreach (var s in ctx.Request.Query["service"])
            if (!string.IsNullOrWhiteSpace(s))
                q.Services.AddRange(s.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        var level = Str(ctx, "level");
        if (level != null) q.MinSeverity = Math.Max(q.MinSeverity, SearchQuery.LevelToSeverity(level));
        return q;
    }

    private static HttpFilter Http(HttpContext ctx) => new(
        Str(ctx, "service"), Str(ctx, "q"), Str(ctx, "status"),
        double.TryParse(ctx.Request.Query["minMs"], CultureInfo.InvariantCulture, out var m) ? m : null,
        Str(ctx, "direction") == "out");

    private static (DateTime From, DateTime To) Range(HttpContext ctx)
    {
        var now = DateTime.UtcNow;
        var to = ParseTime(Str(ctx, "to"), now) ?? now;
        var from = ParseTime(Str(ctx, "from"), to) ?? to.AddHours(-1);
        if (from > to) (from, to) = (to, from);
        return (from, to);
    }

    /// <summary>Date ISO 8601, epoch ms, ou durée relative ("15m", "24h", "7d") comptée depuis <paramref name="reference"/>.</summary>
    public static DateTime? ParseTime(string? value, DateTime reference)
    {
        if (string.IsNullOrWhiteSpace(value) || value == "now") return null;
        if (value.Length >= 2 && char.IsLetter(value[^1]) && double.TryParse(value[..^1], CultureInfo.InvariantCulture, out var n))
        {
            return value[^1] switch
            {
                's' => reference.AddSeconds(-n),
                'm' => reference.AddMinutes(-n),
                'h' => reference.AddHours(-n),
                'd' => reference.AddDays(-n),
                'w' => reference.AddDays(-7 * n),
                _ => null,
            };
        }
        if (long.TryParse(value, out var ms)) return DateTime.UnixEpoch.AddMilliseconds(ms);
        if (DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d))
            return DateTime.SpecifyKind(d, DateTimeKind.Utc);
        return null;
    }

    private static DateTime? Date(HttpContext ctx, string key) => ParseTime(Str(ctx, key), DateTime.UtcNow);

    private static string? Str(HttpContext ctx, string key)
    {
        var v = ctx.Request.Query[key].ToString();
        return string.IsNullOrWhiteSpace(v) ? null : v;
    }

    private static int Int(HttpContext ctx, string key, int fallback) =>
        int.TryParse(ctx.Request.Query[key], out var v) ? v : fallback;
}
