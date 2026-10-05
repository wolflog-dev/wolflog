using static Wolflog.Server.Api.ApiEndpoints;

namespace Wolflog.Server.Api;

/// <summary>
/// Données de Wolflog pour Grafana (plugin « Infinity », source JSON) et tout outil qui lit du JSON :
/// tableaux de lignes plates, séries au format large (une colonne « time » puis une colonne par série).
/// Accès : session de l'interface ou clé de type « lecture » (wlr_…) dans l'en-tête x-wolflog-key.
/// Période : from et to en ms epoch (${__from} et ${__to} dans Grafana), ISO 8601 ou relatif (« 24h »).
/// </summary>
public static class GrafanaEndpoints
{
    extension(WebApplication app)
    {
        public void MapWolflogGrafana()
        {
            var auth = app.Services.GetRequiredService<AuthService>();
            var g = app.MapGroup("/api/grafana").AllowAnonymous();
            g.AddEndpointFilter(async (ictx, next) =>
            {
                var ctx = ictx.HttpContext;
                if (auth.Enabled && auth.ValidateApiKey(AuthService.ReadApiKey(ctx.Request.Headers)) is not { Kind: "read" })
                {
                    if (ctx.User.Identity?.IsAuthenticated != true)
                        return Results.Json(new { error = "Clé de lecture (wlr_…) attendue dans l'en-tête x-wolflog-key." }, statusCode: StatusCodes.Status401Unauthorized);
                    // Session de l'interface : réservée aux comptes qui voient tout (sinon un profil d'accès restreint lirait ici
                    // les logs, requêtes ou métriques qui lui sont fermés dans l'interface).
                    if (ctx.User.UserId() is { } uid && auth.Users.Get(uid) is { } user && !AccessProfileStore.SeesEverything(user))
                        return Results.Json(new { error = "Votre profil d'accès ne permet pas cette lecture : utilisez une clé de lecture (wlr_…)." },
                            statusCode: StatusCodes.Status403Forbidden);
                }
                if (Str(ctx, "env") is { } env) ctx.RequestServices.GetRequiredService<QueryService>().Env = env;
                try { return await next(ictx); }
                catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
            });

            // Test de connexion (bouton « Save & test » de Grafana).
            g.MapGet("", () => Results.Ok(new
            {
                name = "Wolflog", status = "ok",
                endpoints = new[] { "query", "http", "metrics", "logs", "errors", "audience", "audience/summary", "audience/breakdown", "alerts" },
            }));

            // Requête libre : même moteur que le panneau « Requête personnalisée » des tableaux de bord.
            g.MapGet("/query", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var format = Str(ctx, "format") ?? "timeseries";
                var view = format switch { "table" => "top", "stat" => "stat", _ => "timeseries" };
                var groupBy = Str(ctx, "groupBy");
                var cq = new CustomQuery(Str(ctx, "source") ?? "logs", Str(ctx, "filter"), Str(ctx, "agg") ?? "count", Str(ctx, "field"),
                    groupBy, view, Math.Clamp(Int(ctx, "limit", 10), 1, 100), Str(ctx, "service"));
                var r = qs.Custom(cq, from, to, ctx.RequestAborted);
                return view switch
                {
                    "top" => Results.Ok((r.Rows ?? []).Select(x => new Dictionary<string, object?>
                    {
                        [groupBy ?? "group"] = x.Group, ["value"] = x.Value, ["count"] = x.Count,
                    })),
                    "stat" => Results.Ok(new[] { new { value = r.Value, count = r.Count, unit = r.Unit } }),
                    _ => Results.Ok(Wide(r.Times ?? [], r.Series ?? [], "value")),
                };
            });

            // Requêtes HTTP reçues : débit, erreurs, taux d'erreur, latences (une colonne par statistique, ou par groupe).
            g.MapGet("/http", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var filter = new HttpFilter(Str(ctx, "service"), Str(ctx, "route"), Str(ctx, "status"), null, Str(ctx, "outgoing") == "true");
                var stats = (Str(ctx, "stat") ?? "rate,errors,p95").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (Str(ctx, "groupBy") is { } groupBy)
                {
                    var data = qs.HttpSeries(from, to, filter, stats[0], groupBy, ctx.RequestAborted);
                    return Results.Ok(Wide(data.Times, data.Series, stats[0]));
                }
                var all = stats.Take(6).Select(s => qs.HttpSeries(from, to, filter, s, null, ctx.RequestAborted)).ToList();
                if (all.Count == 0) return Results.Ok(Array.Empty<object>());
                var series = all.Select(d => new MetricSeries(d.Stat, d.Stat, d.Series.FirstOrDefault()?.Values ?? d.Times.Select(_ => (double?)null).ToList()));
                return Results.Ok(Wide(all[0].Times, series.ToList(), null));
            });

            // Métriques OpenTelemetry (runtime .NET, métriques applicatives…).
            g.MapGet("/metrics", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var name = Str(ctx, "name");
                if (name is null)
                    return Results.Ok(qs.MetricNames(from, to, Str(ctx, "service"), ctx.RequestAborted));
                var data = qs.MetricSeries(name, from, to, Str(ctx, "service"), Str(ctx, "groupBy"), Str(ctx, "stat"), ctx.RequestAborted);
                return Results.Ok(Wide(data.Times, data.Series, name));
            });

            g.MapGet("/logs", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var q = SearchQuery.Parse(Str(ctx, "filter"));
                q.EnvFilter = qs.EnvFilter; // env:production : environnement configuré
                if (Str(ctx, "service") is { } service) q.Services.Add(service);
                var page = qs.SearchLogs(from, to, q, Math.Clamp(Int(ctx, "limit", 200), 1, 1000), null, ctx.RequestAborted);
                return Results.Ok(page.Items.Select(l => new
                {
                    time = l.Ts, l.Service, level = l.Level, message = l.Body, exception = l.ExceptionType, trace_id = l.TraceId, l.Host, l.Env,
                }));
            });

            g.MapGet("/errors", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var q = new SearchQuery();
                if (Str(ctx, "service") is { } service) q.Services.Add(service);
                var groups = qs.Errors(from, to, q, Math.Clamp(Int(ctx, "limit", 50), 1, 500), ctx.RequestAborted);
                return Results.Ok(groups.Select(e => new
                {
                    exception = e.ExceptionType, message = e.Message, e.Service, count = e.Count, crashes = e.Crashes,
                    first_seen = e.FirstSeen, last_seen = e.LastSeen, fingerprint = e.Fingerprint,
                }));
            });

            // Audience web : visiteurs, utilisateurs identifiés et pages vues, chiffres clés, ventilations (pages, pays, sources…).
            g.MapGet("/audience", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var s = qs.AnalyticsSeries(from, to, AnalyticsFilter.From(ctx.Request.Query), false, ctx.RequestAborted);
                return Results.Ok(s.Times.Select((t, i) => new { time = t, visitors = s.Visitors[i], users = s.Users[i], pageviews = s.Pageviews[i] }));
            });

            g.MapGet("/audience/summary", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                return Results.Ok(new[] { qs.AnalyticsSummary(from, to, AnalyticsFilter.From(ctx.Request.Query), ctx.RequestAborted).Current });
            });

            g.MapGet("/audience/breakdown", (HttpContext ctx, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                var rows = qs.AnalyticsBreakdown(from, to, AnalyticsFilter.From(ctx.Request.Query), Str(ctx, "dimension") ?? "page",
                    Math.Clamp(Int(ctx, "limit", 10), 1, 500), ctx.RequestAborted);
                return Results.Ok(rows.Select(r => new { value = r.Value ?? "(aucun)", visitors = r.Visitors, users = r.Users, count = r.Count }));
            });

            // Alertes en cours : tableau d'état dans Grafana.
            g.MapGet("/alerts", (AlertRuleStore rules, AlertEngine engine) =>
            {
                var byId = rules.All().ToDictionary(r => r.Id);
                return Results.Ok(engine.States().Where(s => s.Status != "ok" && byId.ContainsKey(s.RuleId)).Select(s => new
                {
                    rule = byId[s.RuleId].Name, severity = byId[s.RuleId].Severity, status = s.Status, element = s.Key, since = s.Since,
                    value = s.Value, message = s.Message,
                }));
            });
        }
    }

    /// <summary>
    /// Format large : [{ time, série1, série2… }]. Une série unique sans groupe prend le nom <paramref name="single"/>
    /// (ou son propre nom si null).
    /// </summary>
    private static List<Dictionary<string, object?>> Wide(IReadOnlyList<DateTime> times, IReadOnlyList<MetricSeries> series, string? single)
    {
        var names = series.Select(s =>
            series.Count == 1 && single != null && s.Group is "" or "total" ? single
            : string.IsNullOrEmpty(s.Group) || s.Group == "total" ? s.Name
            : s.Group).ToList();
        var rows = new List<Dictionary<string, object?>>(times.Count);
        for (var i = 0; i < times.Count; i++)
        {
            var row = new Dictionary<string, object?> { ["time"] = times[i] };
            for (var j = 0; j < series.Count; j++)
                row[names[j]] = i < series[j].Values.Count ? series[j].Values[i] : null;
            rows.Add(row);
        }
        return rows;
    }
}
