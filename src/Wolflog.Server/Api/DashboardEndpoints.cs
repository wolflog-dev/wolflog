namespace Wolflog.Server.Api;

/// <summary>
/// Tableaux de bord selon l'accès de chacun (<see cref="DashboardAccess"/>) : liste et lecture limitées aux tableaux visibles
/// et utilisables, panneaux hors du profil retirés de la réponse et conservés à l'enregistrement. Les administrateurs voient tout.
/// </summary>
public static class DashboardEndpoints
{
    extension(WebApplication app)
    {
        public void MapWolflogDashboards(RouteGroupBuilder api, RouteGroupBuilder editor)
        {
            var auth = app.Services.GetRequiredService<AuthService>();
            var profiles = app.Services.GetRequiredService<AccessProfileStore>();
            DashboardAccess Access(HttpContext ctx) => DashboardAccess.For(ctx, auth, profiles);

            api.MapGet("/dashboards", (HttpContext ctx, DashboardStore store) =>
            {
                var access = Access(ctx);
                return Results.Ok(store.All().Where(access.CanUse).Select(d => new
                {
                    d.Id, d.Name, d.Description, Panels = d.Panels.Count(access.Panel), d.VisibleTo, d.UpdatedAt,
                }));
            });

            // Profils proposés dans « Visible pour » : noms seulement (la liste complète reste réservée à l'administration).
            api.MapGet("/dashboards/access-profiles", () => Results.Ok(profiles.All()
                .OrderBy(p => AccessEndpoints.Rank(p.Id)).ThenBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase)
                .Select(p => new { p.Id, p.Name, p.Icon })));

            api.MapGet("/dashboards/{id}", (string id, HttpContext ctx, DashboardStore store) =>
            {
                if (store.Get(id) is not { } d) return Results.NotFound();
                var access = Access(ctx);
                return access.CanUse(d) ? Results.Ok(access.View(d)) : Forbidden(access.Refusal(d));
            });

            editor.MapPost("/dashboards", (Dashboard body, HttpContext ctx, DashboardStore store) =>
            {
                var access = Access(ctx);
                if (access.NormalizeVisibility(body, profiles) is { } error) return Results.BadRequest(new { error });
                body.Id = Guid.NewGuid().ToString("N")[..10];
                body.HiddenPanels = null;
                return Results.Ok(access.View(store.Upsert(body)));
            });

            editor.MapPut("/dashboards/{id}", (string id, Dashboard body, HttpContext ctx, DashboardStore store) =>
            {
                var access = Access(ctx);
                var existing = store.Get(id);
                if (existing is not null && !access.CanUse(existing)) return Forbidden(access.Refusal(existing));
                if (access.NormalizeVisibility(body, profiles, existing) is { } error) return Results.BadRequest(new { error });
                body.Id = id;
                body.HiddenPanels = null;
                // Panneaux que la personne ne voit pas : conservés à leur place.
                if (existing is not null) body.Panels = access.Merge(existing.Panels, body.Panels ?? []);
                return Results.Ok(access.View(store.Upsert(body)));
            });

            editor.MapDelete("/dashboards/{id}", (string id, HttpContext ctx, DashboardStore store) =>
            {
                if (store.Get(id) is not { } d) return Results.NotFound();
                var access = Access(ctx);
                if (!access.CanUse(d)) return Forbidden(access.Refusal(d));
                // Des panneaux que la personne ne voit pas disparaîtraient avec le tableau : réservé à qui voit tout.
                if (d.Panels.Any(p => !access.Panel(p)))
                    return Results.BadRequest(new { error = "Ce tableau contient des panneaux hors de votre profil d'accès : seul un administrateur peut le supprimer." });
                return store.Delete(id) ? Results.Ok() : Results.NotFound();
            });
        }
    }

    private static IResult Forbidden(string error) => Results.Json(new { error }, statusCode: StatusCodes.Status403Forbidden);
}
