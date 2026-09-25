using Microsoft.AspNetCore.Http.Features;
using Wolflog.Server.Hosting;
using Wolflog.Server.Monitoring;
using Wolflog.Server.Query;
using Wolflog.Server.Storage;
using static Wolflog.Server.Api.ApiEndpoints;

namespace Wolflog.Server.Api;

/// <summary>Alertes, canaux de notification, sondes, SLO, santé de Wolflog, sauvegardes.</summary>
public static class MonitoringEndpoints
{
    public sealed record MuteInput(int Minutes);

    extension(WebApplication app)
    {
        public void MapWolflogMonitoring(RouteGroupBuilder api, RouteGroupBuilder editor, RouteGroupBuilder admin)
        {
            // ------------------------------------------------------------ alertes
            api.MapGet("/alerts", (AlertRuleStore rules, AlertEngine engine) =>
            {
                var states = engine.States();
                var list = rules.All().OrderBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase).Select(r =>
                {
                    var mine = states.Where(s => s.RuleId == r.Id).ToList();
                    var status = !r.Enabled ? "disabled"
                        : mine.Any(s => s.Status == "firing") ? "firing"
                        : mine.Any(s => s.Status == "pending") ? "pending" : "ok";
                    return new { rule = r, status, firing = mine.Count(s => s.Status == "firing"), states = mine.Where(s => s.Status != "ok") };
                });
                return Results.Ok(new { rules = list, lastRunAt = engine.LastRunAt });
            });

            api.MapGet("/alerts/active", (AlertRuleStore rules, AlertEngine engine) =>
            {
                var byId = rules.All().ToDictionary(r => r.Id);
                var active = engine.States().Where(s => s.Status != "ok" && byId.ContainsKey(s.RuleId))
                    .OrderByDescending(s => s.Status == "firing").ThenBy(s => byId[s.RuleId].Severity == "critical" ? 0 : 1).ThenByDescending(s => s.Since)
                    .Select(s =>
                    {
                        var r = byId[s.RuleId];
                        return new { s.Id, s.RuleId, ruleName = r.Name, r.Severity, s.Key, s.Status, s.Since, s.Value, s.Message, s.Link,
                            muted = r.MutedUntil > DateTime.UtcNow, r.Runbook };
                    }).ToList();
                return Results.Ok(new { items = active, firing = active.Count(a => a.Status == "firing") });
            });

            api.MapGet("/alerts/history", (HttpContext ctx, AlertEventStore events) =>
            {
                var (from, to) = Range(ctx);
                var rule = Str(ctx, "rule");
                return Results.Ok(events.All().Where(e => e.At >= from && e.At <= to && (rule is null || e.RuleId == rule))
                    .OrderByDescending(e => e.At).Take(Int(ctx, "limit", 300)));
            });

            editor.MapPost("/alerts/preview", (AlertRule body, AlertEngine engine, CancellationToken ct) =>
            {
                try { return Results.Ok(engine.Preview(Normalize(body), ct)); }
                catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
            });

            editor.MapPost("/alerts", (AlertRule body, HttpContext ctx, AlertRuleStore rules, AlertChannelStore channels) =>
            {
                body.Id = "";
                body.CreatedBy = ctx.User.Identity?.Name;
                body.CreatedAt = DateTime.UtcNow;
                if (body.Channels.Count == 0) body.Channels = channels.All().Where(c => c.Default).Select(c => c.Id).ToList();
                return Validate(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(rules.Upsert(Normalize(body)));
            });

            editor.MapPut("/alerts/{id}", (string id, AlertRule body, AlertRuleStore rules) =>
            {
                var existing = rules.Get(id);
                if (existing is null) return Results.NotFound();
                body.Id = id;
                body.CreatedBy = existing.CreatedBy;
                body.CreatedAt = existing.CreatedAt;
                return Validate(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(rules.Upsert(Normalize(body)));
            });

            editor.MapDelete("/alerts/{id}", (string id, AlertRuleStore rules) => rules.Delete(id) ? Results.Ok() : Results.NotFound());

            editor.MapPost("/alerts/{id}/mute", (string id, MuteInput body, AlertRuleStore rules) =>
            {
                var r = rules.Update(id, r => r.MutedUntil = body.Minutes > 0 ? DateTime.UtcNow.AddMinutes(body.Minutes) : null);
                return r is null ? Results.NotFound() : Results.Ok(r);
            });

            editor.MapPost("/alerts/run", async (AlertEngine engine, CancellationToken ct) =>
            {
                await engine.RunOnceAsync(ct);
                return Results.Ok();
            });

            // ------------------------------------------------------------ canaux de notification
            api.MapGet("/alert-channels", (HttpContext ctx, AlertChannelStore channels) =>
            {
                var admin = !app.Services.GetRequiredService<Security.AuthService>().Enabled || Security.Roles.Allows(Security.SessionPrincipal.Role(ctx.User), Security.Roles.Admin);
                return Results.Ok(channels.All().OrderBy(c => c.Name).Select(c => new
                {
                    c.Id, c.Name, c.Type, c.Default, c.LastSentAt, c.LastErrorAt, c.LastError,
                    // Une URL de webhook donne le droit de publier : visible des seuls administrateurs.
                    target = admin || c.Type == "email" ? c.Target : Mask(c.Target),
                }));
            });

            admin.MapPost("/alert-channels", (AlertChannel body, AlertChannelStore channels) =>
            {
                body.Id = "";
                return ValidateChannel(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(channels.Upsert(body));
            });

            admin.MapPut("/alert-channels/{id}", (string id, AlertChannel body, AlertChannelStore channels) =>
            {
                if (channels.Get(id) is null) return Results.NotFound();
                body.Id = id;
                return ValidateChannel(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(channels.Upsert(body));
            });

            admin.MapDelete("/alert-channels/{id}", (string id, AlertChannelStore channels, AlertRuleStore rules) =>
            {
                foreach (var r in rules.All().Where(r => r.Channels.Contains(id)))
                    rules.Update(r.Id, x => x.Channels.Remove(id));
                return channels.Delete(id) ? Results.Ok() : Results.NotFound();
            });

            // Test d'un canal (enregistré ou en cours de saisie).
            admin.MapPost("/alert-channels/test", async (AlertChannel body, Notifier notifier, AlertChannelStore channels, CancellationToken ct) =>
            {
                var channel = !string.IsNullOrEmpty(body.Id) && channels.Get(body.Id) is { } saved && string.IsNullOrEmpty(body.Target) ? saved : body;
                if (ValidateChannel(channel) is { } invalid) return Results.BadRequest(new { error = invalid });
                var error = await notifier.TrySendAsync(channel,
                    new AlertNotification("test", "notification de test", "warning", "Si vous lisez ce message, le canal fonctionne.", "/alerts", null, DateTime.UtcNow), ct);
                return error is null ? Results.Ok() : Results.BadRequest(new { error });
            });

            admin.MapGet("/notification-settings", (NotificationSettingsStore store) =>
            {
                var s = store.Current;
                return Results.Ok(new { s.PublicUrl, s.SmtpHost, s.SmtpPort, s.SmtpSsl, s.SmtpUser, s.From, hasPassword = !string.IsNullOrEmpty(s.SmtpPassword) });
            });

            admin.MapPut("/notification-settings", (NotificationSettings body, NotificationSettingsStore store) =>
            {
                var current = store.Current;
                body.Id = "mail";
                // Mot de passe non renvoyé à l'interface : vide = inchangé.
                if (string.IsNullOrEmpty(body.SmtpPassword)) body.SmtpPassword = current.SmtpPassword;
                body.PublicUrl = body.PublicUrl?.Trim().TrimEnd('/');
                store.Upsert(body);
                return Results.Ok();
            });

            // ------------------------------------------------------------ sondes
            api.MapGet("/probes", (HttpContext ctx, ProbeStore probes, ProbeEngine engine, QueryService qs) =>
            {
                var (from, to) = Range(ctx);
                qs.Env = null;
                var stats = qs.ProbeStats(from, to, Int(ctx, "buckets", 60), ctx.RequestAborted).ToDictionary(s => s.ProbeId);
                return Results.Ok(probes.All().OrderBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase).Select(p =>
                {
                    stats.TryGetValue(p.Id, out var st);
                    var state = engine.State(p.Id);
                    return new { probe = p, status = p.Enabled ? state?.Status ?? "unknown" : "paused", since = state?.Since, last = state?.Last, recent = state?.Recent, stats = st };
                }));
            });

            editor.MapPost("/probes", (Probe body, ProbeStore probes) =>
            {
                body.Id = "";
                body.CreatedAt = DateTime.UtcNow;
                return ValidateProbe(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(probes.Upsert(body));
            });

            editor.MapPut("/probes/{id}", (string id, Probe body, ProbeStore probes) =>
            {
                var existing = probes.Get(id);
                if (existing is null) return Results.NotFound();
                body.Id = id;
                body.CreatedAt = existing.CreatedAt;
                return ValidateProbe(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(probes.Upsert(body));
            });

            editor.MapDelete("/probes/{id}", (string id, ProbeStore probes) => probes.Delete(id) ? Results.Ok() : Results.NotFound());

            // Essai immédiat : sonde enregistrée (résultat conservé) ou en cours de saisie (non conservé).
            editor.MapPost("/probes/test", async (Probe body, ProbeStore probes, ProbeEngine engine, CancellationToken ct) =>
            {
                if (ValidateProbe(body) is { } error) return Results.BadRequest(new { error });
                var saved = !string.IsNullOrEmpty(body.Id) && probes.Get(body.Id) is not null;
                return Results.Ok(await engine.RunAsync(body, ct, record: saved));
            });

            // ------------------------------------------------------------ SLO
            api.MapGet("/slos", (SloStore slos, QueryService qs, CancellationToken ct) =>
            {
                qs.Env = null;
                return Results.Ok(slos.All().OrderBy(s => s.Name, StringComparer.CurrentCultureIgnoreCase)
                    .Select(s => new { slo = s, status = SloCalculator.Status(qs, s, ct) }));
            });

            api.MapGet("/slos/{id}", (string id, SloStore slos, QueryService qs, CancellationToken ct) =>
            {
                qs.Env = null;
                var s = slos.Get(id);
                return s is null ? Results.NotFound() : Results.Ok(new { slo = s, status = SloCalculator.Status(qs, s, ct), history = SloCalculator.History(qs, s, ct) });
            });

            // Aperçu d'un objectif en cours de saisie : ce qu'il mesurerait aujourd'hui.
            editor.MapPost("/slos/preview", (Slo body, QueryService qs, CancellationToken ct) =>
            {
                qs.Env = null;
                if (ValidateSlo(body) is { } error && !error.StartsWith("Donnez")) return Results.BadRequest(new { error });
                return Results.Ok(SloCalculator.Status(qs, body, ct));
            });

            editor.MapPost("/slos", (Slo body, SloStore slos) =>
            {
                body.Id = "";
                body.CreatedAt = DateTime.UtcNow;
                return ValidateSlo(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(slos.Upsert(body));
            });

            editor.MapPut("/slos/{id}", (string id, Slo body, SloStore slos) =>
            {
                var existing = slos.Get(id);
                if (existing is null) return Results.NotFound();
                body.Id = id;
                body.CreatedAt = existing.CreatedAt;
                return ValidateSlo(body) is { } error ? Results.BadRequest(new { error }) : Results.Ok(slos.Upsert(body));
            });

            editor.MapDelete("/slos/{id}", (string id, SloStore slos) => slos.Delete(id) ? Results.Ok() : Results.NotFound());

            // ------------------------------------------------------------ santé et sauvegardes
            api.MapGet("/health/wolflog", (HealthService health) => Results.Ok(health.Check()));

            admin.MapGet("/admin/backup", async (HttpContext ctx, StorageHost storage, BackupState state) =>
            {
                var includeData = Str(ctx, "data") is "true" or "1";
                if (includeData) await Task.WhenAll(storage.All.Select(s => s.FlushAsync())); // données en mémoire incluses
                ctx.Response.ContentType = "application/zip";
                ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"wolflog-{(includeData ? "complet" : "config")}-{DateTime.Now:yyyyMMdd-HHmm}.zip\"";
                // L'archive est produite au fil de l'eau (ZipArchive écrit de façon synchrone).
                var body = ctx.Features.Get<IHttpBodyControlFeature>();
                if (body != null) body.AllowSynchronousIO = true;
                Backup.Write(storage.DataDirectory, ctx.Response.Body, includeData);
                state.Mark();
            });

            admin.MapPost("/admin/restore", async (HttpContext ctx, StorageHost storage, Dashboards.DashboardStore dashboards) =>
            {
                if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { error = "Envoyez le fichier .zip de sauvegarde." });
                var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
                var file = form.Files.FirstOrDefault();
                if (file is null) return Results.BadRequest(new { error = "Fichier manquant." });
                using var buffer = new MemoryStream();
                await file.CopyToAsync(buffer, ctx.RequestAborted);
                buffer.Position = 0;
                try
                {
                    // Configuration seulement : les données se restaurent serveur arrêté (wolflog restore).
                    var result = Backup.Restore(storage.DataDirectory, buffer, includeData: false);
                    dashboards.Reload();
                    return Results.Ok(result);
                }
                catch (InvalidDataException) { return Results.BadRequest(new { error = "Ce fichier n'est pas une sauvegarde Wolflog valide." }); }
            }).DisableAntiforgery();
        }
    }

    private static string Mask(string target) =>
        Uri.TryCreate(target, UriKind.Absolute, out var u) ? $"{u.Scheme}://{u.Host}/…" : "…";

    private static AlertRule Normalize(AlertRule r)
    {
        r.Name = r.Name?.Trim() ?? "";
        r.WindowMinutes = Math.Clamp(r.WindowMinutes, 1, 7 * 24 * 60);
        r.ForMinutes = Math.Clamp(r.ForMinutes, 0, 24 * 60);
        r.RepeatMinutes = Math.Clamp(r.RepeatMinutes, 0, 7 * 24 * 60);
        r.Severity = r.Severity == "warning" ? "warning" : "critical";
        r.Comparison = r.Comparison == "below" ? "below" : "above";
        r.Channels ??= [];
        foreach (var p in new[] { nameof(r.Service), nameof(r.Env), nameof(r.Filter), nameof(r.GroupBy), nameof(r.Route), nameof(r.TargetId) })
        {
            var prop = typeof(AlertRule).GetProperty(p)!;
            if (prop.GetValue(r) is string s && string.IsNullOrWhiteSpace(s)) prop.SetValue(r, null);
        }
        return r;
    }

    private static string? Validate(AlertRule r)
    {
        if (string.IsNullOrWhiteSpace(r.Name)) return "Donnez un nom à l'alerte.";
        if (!AlertKinds.All.Contains(r.Kind)) return "Type d'alerte inconnu.";
        if (r.Kind == AlertKinds.Query && r.Aggregate is not (null or "count" or "rate" or "distinct") && string.IsNullOrWhiteSpace(r.Field))
            return "Choisissez le champ à calculer.";
        return null;
    }

    private static string? ValidateChannel(AlertChannel c)
    {
        if (string.IsNullOrWhiteSpace(c.Name)) return "Donnez un nom au canal.";
        if (string.IsNullOrWhiteSpace(c.Target)) return c.Type == "email" ? "Indiquez au moins une adresse e-mail." : "Indiquez l'URL du webhook.";
        if (c.Type != "email" && !(Uri.TryCreate(c.Target, UriKind.Absolute, out var u) && u.Scheme is "http" or "https"))
            return "L'URL du webhook doit commencer par https://.";
        return null;
    }

    private static string? ValidateProbe(Probe p)
    {
        if (string.IsNullOrWhiteSpace(p.Name)) return "Donnez un nom à la sonde.";
        if (p.Type == "tcp")
            return p.Target.Contains(':') ? null : "Cible TCP attendue sous la forme hôte:port.";
        return Uri.TryCreate(p.Target, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" ? null : "L'adresse doit commencer par http:// ou https://.";
    }

    private static string? ValidateSlo(Slo s)
    {
        if (string.IsNullOrWhiteSpace(s.Name)) return "Donnez un nom à l'objectif.";
        if (s.TargetPercent is <= 0 or >= 100) return "L'objectif doit être compris entre 0 et 100 % (ex. 99,9).";
        if (s.Source == "probe" && string.IsNullOrWhiteSpace(s.ProbeId)) return "Choisissez la sonde.";
        if (s.Source != "probe" && string.IsNullOrWhiteSpace(s.Service)) return "Choisissez le service.";
        return null;
    }
}
