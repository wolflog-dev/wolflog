using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace Wolflog.Server.Api;

public static class ApiEndpoints
{
    public sealed record LoginRequest(string? Username, string? Password);

    extension(WebApplication app)
    {
        public void MapWolflogApi()
        {
            var auth = app.Services.GetRequiredService<AuthService>();

            app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
            app.MapWolflogRum();

            // ------------------------------------------------------------ authentification
            var authGroup = app.MapGroup("/api/auth").AllowAnonymous();
            authGroup.MapGet("/me", (HttpContext ctx, AccessProfileStore profiles) =>
            {
                var user = auth.Enabled && ctx.User.UserId() is { } uid ? auth.Users.Get(uid) : null;
                var access = !auth.Enabled ? AccessGrant.Full : user is null ? null : profiles.GrantFor(user);
                Monitoring.Notifier.ObservedOrigin ??= $"{ctx.Request.Scheme}://{ctx.Request.Host}{ctx.Request.PathBase}";
                return Results.Ok(new
                {
                    authEnabled = auth.Enabled,
                    authenticated = !auth.Enabled || user != null,
                    user = auth.Enabled ? user?.Username : "local",
                    displayName = auth.Enabled ? user?.DisplayName ?? user?.Username : "Accès local",
                    role = auth.Enabled ? user?.Role : Roles.Admin,
                    source = user?.Source,
                    mustChangePassword = user?.MustChangePassword ?? false,
                    sso = ctx.RequestServices.GetRequiredService<SsoSchemes>().Describe(ctx),
                    // Profil d'accès : parties visibles (ordre de la navigation ; toutes pour un administrateur) et page d'accueil.
                    sections = access?.Sections ?? [],
                    home = access?.Home,
                    profile = access?.Profile is { } p ? new { p.Id, p.Name } : null,
                    // Services visibles (noms ou motifs « boutique-* ») ; null : tous.
                    services = access is { Services.IsAll: false } ? access.Services.Patterns : null,
                });
            });
            authGroup.MapPost("/login", async (HttpContext ctx, LoginRequest body, PasswordSignIn signIn) =>
            {
                if (!auth.Enabled) return Results.Ok();
                // Compte Wolflog local d'abord, sinon l'annuaire LDAP / Active Directory s'il est activé.
                var (user, status, error) = await signIn.SignInAsync(body.Username, body.Password, ctx.RequestAborted);
                if (user is null)
                {
                    await Task.Delay(Random.Shared.Next(300, 600)); // ralentit le brute force
                    return Results.Json(new { error }, statusCode: status);
                }
                await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, SessionPrincipal.Create(user),
                    new AuthenticationProperties { IsPersistent = true });
                return Results.Ok();
            });
            authGroup.MapPost("/logout", async (HttpContext ctx) =>
            {
                await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                SsoEndpoints.RememberSignOut(ctx);
                return Results.Ok();
            });

            var api = app.MapGroup("/api");
            if (auth.Enabled) api.RequireAuthorization();

            // Groupes par rôle : lecture (tout utilisateur connecté), édition, administration.
            var editor = auth.Enabled ? api.MapGroup("").RequireAuthorization(Roles.Editor) : api.MapGroup("");
            var admin = auth.Enabled ? api.MapGroup("").RequireAuthorization(Roles.Admin) : api.MapGroup("");
            app.MapWolflogAdmin(api, editor, admin);
            app.MapWolflogAccess(api, admin);
            app.MapWolflogWorkflow(api, editor);
            app.MapWolflogMonitoring(api, editor, admin);
            app.MapWolflogSources(admin);
            app.MapWolflogSso(authGroup, admin);
            app.MapWolflogProfiling(api, editor);
            app.MapWolflogAnalytics(api);
            app.MapWolflogHeatmapViewer();
            app.MapWolflogGrafana();
            app.MapWolflogBranding(admin);
            app.MapWolflogEnvironments(api, admin);

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

                // Services visibles du compte (profil d'accès) : évalués en mémoire, comme la recherche.
                var visible = ctx.VisibleServices;
                using var sub = storage.Tail.Subscribe(r => visible.Allows(r.Service) && q.Matches(r));
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
            {
                var trace = qs.GetTrace(traceId, Date(ctx, "around"), ctx.RequestAborted);
                // Compte limité à certains services : seulement leurs spans ; aucun → trace introuvable pour lui.
                return !qs.Scope.IsAll && trace.Spans.Count == 0 ? Results.NotFound() : Results.Ok(trace);
            });

            // ------------------------------------------------------------ erreurs / crashs
            api.MapGet("/errors", (HttpContext ctx, QueryService qs, Configuration.ErrorStateStore states) =>
            {
                var (from, to) = Range(ctx);
                var groups = WorkflowEndpoints.WithStatus(qs.Errors(from, to, Search(ctx), 1000, ctx.RequestAborted), states);
                var status = Str(ctx, "status") ?? "all";
                var counts = new
                {
                    todo = groups.Count(g => g.Status is Configuration.ErrorStatus.Open or Configuration.ErrorStatus.Regressed),
                    resolved = groups.Count(g => g.Status == Configuration.ErrorStatus.Resolved),
                    ignored = groups.Count(g => g.Status == Configuration.ErrorStatus.Ignored),
                    mine = groups.Count(g => g.AssignedTo != null && g.AssignedTo == ctx.User.Identity?.Name && g.Status != Configuration.ErrorStatus.Resolved),
                    all = groups.Count,
                };
                IEnumerable<Query.ErrorGroup> filtered = status switch
                {
                    "todo" => groups.Where(g => g.Status is Configuration.ErrorStatus.Open or Configuration.ErrorStatus.Regressed),
                    "resolved" or "ignored" => groups.Where(g => g.Status == status),
                    "mine" => groups.Where(g => g.AssignedTo != null && g.AssignedTo == ctx.User.Identity?.Name && g.Status != Configuration.ErrorStatus.Resolved),
                    _ => groups,
                };
                return Results.Ok(new { items = filtered.Take(Int(ctx, "limit", 200)), counts });
            });

            api.MapGet("/errors/{fingerprint}", (string fingerprint, HttpContext ctx, QueryService qs, Configuration.ErrorStateStore states) =>
            {
                var (from, to) = Range(ctx);
                var detail = qs.ErrorDetail(fingerprint, from, to, ctx.RequestAborted);
                if (detail is null) return Results.NotFound();
                var state = states.Get(fingerprint);
                return Results.Ok(detail with
                {
                    Group = detail.Group with { Status = Configuration.ErrorStatus.Effective(state, detail.Group.LastSeen), AssignedTo = state?.AssignedTo },
                    State = state,
                });
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

            api.MapGet("/metrics/exemplars", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var name = Str(ctx, "name");
                return name is null ? Results.BadRequest("name requis")
                    : Results.Ok(qs.MetricExemplars(name, from, to, Str(ctx, "service"), Int(ctx, "limit", 50), ctx.RequestAborted));
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

            api.MapGet("/service-map", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.ServiceMap(from, to, ctx.RequestAborted));
            });

            // Environnements (/environments, /environments/stats) : EnvironmentEndpoints.

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

            // ------------------------------------------------------------ tableaux de bord (selon l'accès de chacun)
            app.MapWolflogDashboards(api, editor);

            // ------------------------------------------------------------ vue d'ensemble / système
            api.MapGet("/services", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(qs.Services(from, to, ctx.RequestAborted));
            });

            api.MapGet("/overview", (HttpContext ctx, QueryService qs, Configuration.ErrorStateStore states) =>
            {
                var (from, to) = Range(ctx);
                var overview = qs.Overview(from, to, ctx.RequestAborted);
                // Les erreurs ignorées ou résolues (et non revues) ne remontent pas dans la vue d'ensemble.
                var top = WorkflowEndpoints.WithStatus(overview.TopErrors, states)
                    .Where(g => g.Status is Configuration.ErrorStatus.Open or Configuration.ErrorStatus.Regressed).Take(8).ToList();
                return Results.Ok(overview with { TopErrors = top });
            });

            api.MapGet("/system", (QueryService qs) => Results.Ok(qs.Stats()));

            admin.MapGet("/system/integration", (HttpContext ctx) => Results.Ok(new
            {
                endpoint = $"{ctx.Request.Scheme}://{ctx.Request.Host}",
                apiKey = auth.Enabled ? auth.PrimaryApiKey : null,
                authEnabled = auth.Enabled,
            }));

            admin.MapPost("/system/flush", async (StorageHost storage) =>
            {
                await Task.WhenAll(storage.All.Select(s => s.FlushAsync()));
                return Results.Ok();
            });

            admin.MapPost("/system/compact", async (StorageHost storage) =>
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

    internal static LogItem ToItem(LogRow r) => new(
        DateTime.SpecifyKind(r.Ts, DateTimeKind.Utc), r.Service, r.Host, r.Env, r.Version, r.Severity, SearchQuery.SeverityToLevel(r.Severity),
        r.Body, r.TraceId, r.SpanId, r.Category, r.ExceptionType, r.ExceptionMessage, r.ExceptionStack, r.Fingerprint, r.IsCrash,
        r.Attributes, r.Resource);

    // ------------------------------------------------------------ paramètres

    internal static SearchQuery Search(HttpContext ctx)
    {
        var q = SearchQuery.Parse(ctx.Request.Query["q"]);
        // env:production (recherche) et ?env= du suivi en direct : environnements configurés.
        q.EnvFilter = ctx.RequestServices.GetRequiredService<EnvironmentStore>().Filter;
        foreach (var s in ctx.Request.Query["service"])
            if (!string.IsNullOrWhiteSpace(s))
                q.Services.AddRange(s.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        var level = Str(ctx, "level");
        if (level != null) q.MinSeverity = Math.Max(q.MinSeverity, SearchQuery.LevelToSeverity(level));
        return q;
    }

    internal static HttpFilter Http(HttpContext ctx) => new(
        Str(ctx, "service"), Str(ctx, "q"), Str(ctx, "status"),
        double.TryParse(ctx.Request.Query["minMs"], CultureInfo.InvariantCulture, out var m) ? m : null,
        Str(ctx, "direction") == "out");

    internal static (DateTime From, DateTime To) Range(HttpContext ctx)
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

    internal static string? Str(HttpContext ctx, string key)
    {
        var v = ctx.Request.Query[key].ToString();
        return string.IsNullOrWhiteSpace(v) ? null : v;
    }

    internal static int Int(HttpContext ctx, string key, int fallback) =>
        int.TryParse(ctx.Request.Query[key], out var v) ? v : fallback;
}
