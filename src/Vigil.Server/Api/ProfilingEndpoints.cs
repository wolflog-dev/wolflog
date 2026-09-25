using System.IO.Compression;
using System.Text.Json;
using Vigil.Server.Monitoring;

namespace Vigil.Server.Api;

/// <summary>Profilage à la demande : les applications interrogent /v1/profiling/poll et envoient /v1/profiles.</summary>
public static class ProfilingEndpoints
{
    public sealed record RequestInput(string? Service, string? Instance, string? Kind, int? Seconds);

    public sealed class Upload
    {
        public string Id { get; set; } = "";
        public string Service { get; set; } = "";
        public string Instance { get; set; } = "";
        public string? Host { get; set; }
        public string? Version { get; set; }
        public string Kind { get; set; } = "cpu";
        public DateTime Start { get; set; }
        public double Seconds { get; set; }
        public long Samples { get; set; }
        public string? Error { get; set; }
        public List<StackWeight> Stacks { get; set; } = [];
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    extension(WebApplication app)
    {
        public void MapVigilProfiling(RouteGroupBuilder api, RouteGroupBuilder editor)
        {
            // Côté application (clé d'ingestion, contrôlée par le middleware /v1).
            app.MapGet("/v1/profiling/poll", (string service, string instance, string? host, string? version, string? runtime, ProfileStore store) =>
                Results.Ok(new { requests = store.Poll(service, instance, host, version, runtime) })).AllowAnonymous();

            app.MapPost("/v1/profiles", async (HttpContext ctx, ProfileStore store) =>
            {
                Stream body = ctx.Request.Body;
                if (ctx.Request.Headers.ContentEncoding.ToString().Contains("gzip")) body = new GZipStream(body, CompressionMode.Decompress);
                var upload = await JsonSerializer.DeserializeAsync<Upload>(body, Json, ctx.RequestAborted);
                if (upload is null || !ProfileStore.IsValidId(upload.Id)) return Results.BadRequest();
                // Seul un profil demandé depuis l'interface peut être reçu.
                var existing = store.Get(upload.Id);
                if (existing is null) return Results.NotFound();
                store.Save(upload.Id, new ProfileInfo
                {
                    Service = upload.Service, Instance = upload.Instance, Host = upload.Host, Version = upload.Version, Kind = upload.Kind,
                    Start = upload.Start, Seconds = upload.Seconds, Samples = upload.Samples, Error = upload.Error,
                    RequestedBy = existing.RequestedBy, RequestedAt = existing.RequestedAt,
                }, upload.Stacks);
                return Results.Ok();
            }).AllowAnonymous();

            // Côté interface.
            api.MapGet("/profiling/instances", (ProfileStore store) => Results.Ok(store.Instances()));

            api.MapGet("/profiles", (HttpContext ctx, ProfileStore store) =>
            {
                store.Expire();
                var service = ctx.Request.Query["service"].ToString();
                return Results.Ok(store.All().Where(p => string.IsNullOrEmpty(service) || p.Service == service)
                    .OrderByDescending(p => p.RequestedAt).Take(200));
            });

            api.MapGet("/profiles/{id}", (string id, ProfileStore store) =>
            {
                var info = store.Get(id);
                if (info is null) return Results.NotFound();
                return Results.Ok(new { info, stacks = store.Stacks(id) ?? [] });
            });

            editor.MapPost("/profiles", (RequestInput body, HttpContext ctx, ProfileStore store) =>
            {
                if (string.IsNullOrWhiteSpace(body.Service)) return Results.BadRequest(new { error = "Choisissez le service à profiler." });
                return Results.Ok(store.Request(body.Service, body.Instance, body.Kind ?? "cpu", body.Seconds ?? 30, ctx.User.Identity?.Name));
            });

            editor.MapDelete("/profiles/{id}", (string id, ProfileStore store) =>
            {
                store.Remove(id);
                return Results.Ok();
            });
        }
    }
}
