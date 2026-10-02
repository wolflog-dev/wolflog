using static Wolflog.Server.Api.ApiEndpoints;

namespace Wolflog.Server.Api;

/// <summary>
/// Environnements : liste du sélecteur de la barre du haut (tout compte connecté), réglages et regroupement automatique
/// (administrateurs). La façon dont un environnement configuré filtre les données est décrite dans <see cref="EnvironmentFilter"/>.
/// </summary>
public static class EnvironmentEndpoints
{
    /// <summary>Période des valeurs reçues montrées dans Administration › Environnements.</summary>
    private const int SeenDays = 30;

    extension(WebApplication app)
    {
        public void MapWolflogEnvironments(RouteGroupBuilder api, RouteGroupBuilder admin)
        {
            // Noms à passer dans ?env= (7 derniers jours), dans l'ordre du sélecteur, sans les environnements masqués.
            // ?service= : ceux où cette application a envoyé des données, sans ceux qu'elle masque.
            api.MapGet("/environments", (HttpContext ctx, QueryService qs) =>
                Results.Ok(qs.Environments(Str(ctx, "service"), ctx.RequestAborted)));

            // Les mêmes, avec libellé, type et couleur, ordre, valeurs regroupées, applications et activité sur 7 jours.
            api.MapGet("/environments/stats", (HttpContext ctx, QueryService qs) =>
                Results.Ok(qs.EnvironmentStats(Str(ctx, "service"), ctx.RequestAborted)));

            // Réglages, et valeurs reçues de chaque application sur 30 jours (à regrouper).
            admin.MapGet("/admin/environments", (HttpContext ctx, QueryService qs, EnvironmentStore store) =>
            {
                var seen = qs.ReceivedEnvironments(DateTime.UtcNow.AddDays(-SeenDays), null, ctx.RequestAborted);
                var s = store.Current;
                return Results.Ok(new { s.Environments, s.Apps, s.UpdatedAt, s.UpdatedBy, seen });
            });

            admin.MapPut("/admin/environments", (EnvironmentSettings body, HttpContext ctx, EnvironmentStore store) =>
            {
                var (settings, error) = EnvironmentStore.Check(body);
                if (settings is null) return Results.BadRequest(new { error });
                var s = store.Save(settings, ctx.User.Identity?.Name);
                return Results.Ok(new { s.Environments, s.Apps, s.UpdatedAt, s.UpdatedBy });
            });

            // « Regrouper automatiquement » : proposition à partir des réglages en cours de saisie, sans rien enregistrer.
            admin.MapPost("/admin/environments/suggest", (EnvironmentSettings body, HttpContext ctx, QueryService qs) =>
            {
                var received = qs.ReceivedEnvironments(DateTime.UtcNow.AddDays(-SeenDays), null, ctx.RequestAborted).Select(u => u.Env);
                var (proposal, grouped, created) = EnvironmentSuggestion.Propose(body, received);
                return Results.Ok(new { proposal.Environments, proposal.Apps, grouped, created });
            });
        }
    }
}
