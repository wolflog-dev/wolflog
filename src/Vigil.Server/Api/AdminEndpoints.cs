using Vigil.Server.Security;

namespace Vigil.Server.Api;

public static class AdminEndpoints
{
    public sealed record PasswordChange(string? Current, string? Next);
    public sealed record UserInput(string? Username, string? DisplayName, string? Email, string? Role, string? Password, bool? Disabled);
    public sealed record KeyInput(string? Name, string? Kind, List<string>? Origins);

    /// <summary>Vue publique d'un compte (jamais l'empreinte du mot de passe).</summary>
    public static object View(User u) => new
    {
        u.Id, u.Username, u.DisplayName, u.Email, u.Role, u.Source, u.Disabled, u.MustChangePassword, u.CreatedAt, u.LastLoginAt,
    };

    extension(WebApplication app)
    {
        public void MapVigilAdmin(RouteGroupBuilder api, RouteGroupBuilder editor, RouteGroupBuilder admin)
        {
            var auth = app.Services.GetRequiredService<AuthService>();

            // ------------------------------------------------------------ mon compte
            api.MapPost("/account/password", (HttpContext ctx, PasswordChange body) =>
            {
                var id = ctx.User.UserId();
                var user = id is null ? null : auth.Users.Get(id);
                if (user is null || user.Source != "local") return Results.BadRequest(new { error = "Ce compte n'a pas de mot de passe Vigil (connexion SSO)." });
                if (!Passwords.Verify(body.Current ?? "", user.PasswordHash)) return Results.BadRequest(new { error = "Mot de passe actuel incorrect." });
                if ((body.Next ?? "").Length < 10) return Results.BadRequest(new { error = "10 caractères minimum." });
                auth.Users.Update(user.Id, u => { u.PasswordHash = Passwords.Hash(body.Next!); u.MustChangePassword = false; });
                return Results.Ok();
            });

            // ------------------------------------------------------------ utilisateurs
            admin.MapGet("/admin/users", () => Results.Ok(auth.Users.All().OrderBy(u => u.Username).Select(View)));

            admin.MapPost("/admin/users", (UserInput body, HttpContext ctx) =>
            {
                var username = body.Username?.Trim();
                if (string.IsNullOrEmpty(username)) return Results.BadRequest(new { error = "Nom d'utilisateur requis." });
                if (auth.Users.ByUsername(username) != null) return Results.BadRequest(new { error = "Ce nom d'utilisateur existe déjà." });
                var password = string.IsNullOrEmpty(body.Password) ? Passwords.Generate(9) : body.Password;
                var user = auth.Users.Upsert(new User
                {
                    Username = username,
                    DisplayName = body.DisplayName?.Trim(),
                    Email = body.Email?.Trim(),
                    Role = Roles.IsValid(body.Role) ? body.Role! : Roles.Viewer,
                    PasswordHash = Passwords.Hash(password),
                    MustChangePassword = true,
                });
                // Mot de passe provisoire renvoyé une seule fois, à transmettre à la personne.
                return Results.Ok(new { user = View(user), temporaryPassword = password });
            });

            admin.MapPut("/admin/users/{id}", (string id, UserInput body, HttpContext ctx) =>
            {
                var target = auth.Users.Get(id);
                if (target is null) return Results.NotFound();
                var demotesLastAdmin = target.Role == Roles.Admin && ((body.Role != null && body.Role != Roles.Admin) || body.Disabled == true)
                                       && auth.Users.All().Count(u => u.Role == Roles.Admin && !u.Disabled) == 1;
                if (demotesLastAdmin) return Results.BadRequest(new { error = "Il faut garder au moins un administrateur actif." });
                if (id == ctx.User.UserId() && body.Disabled == true) return Results.BadRequest(new { error = "Vous ne pouvez pas désactiver votre propre compte." });
                var user = auth.Users.Update(id, u =>
                {
                    if (body.DisplayName != null) u.DisplayName = body.DisplayName.Trim();
                    if (body.Email != null) u.Email = body.Email.Trim();
                    if (Roles.IsValid(body.Role)) u.Role = body.Role!;
                    if (body.Disabled is { } d) u.Disabled = d;
                });
                return Results.Ok(View(user!));
            });

            admin.MapPost("/admin/users/{id}/reset-password", (string id) =>
            {
                var password = Passwords.Generate(9);
                var user = auth.Users.Update(id, u =>
                {
                    u.PasswordHash = Passwords.Hash(password);
                    u.MustChangePassword = true;
                    u.Source = "local";
                });
                return user is null ? Results.NotFound() : Results.Ok(new { temporaryPassword = password });
            });

            admin.MapDelete("/admin/users/{id}", (string id, HttpContext ctx) =>
            {
                var target = auth.Users.Get(id);
                if (target is null) return Results.NotFound();
                if (id == ctx.User.UserId()) return Results.BadRequest(new { error = "Vous ne pouvez pas supprimer votre propre compte." });
                if (target.Role == Roles.Admin && auth.Users.All().Count(u => u.Role == Roles.Admin && !u.Disabled) == 1)
                    return Results.BadRequest(new { error = "Il faut garder au moins un administrateur actif." });
                auth.Users.Delete(id);
                return Results.Ok();
            });

            // ------------------------------------------------------------ clés d'ingestion
            admin.MapGet("/admin/keys", () =>
            {
                auth.Keys.FlushUsage();
                return Results.Ok(new
                {
                    configKeys = auth.ConfigKeyCount,
                    keys = auth.Keys.All().OrderByDescending(k => k.CreatedAt).Select(k => new
                    {
                        k.Id, k.Name, k.Kind, k.Prefix, k.AllowedOrigins, k.CreatedAt, k.CreatedBy, k.LastUsedAt, k.RevokedAt,
                    }),
                });
            });

            admin.MapPost("/admin/keys", (KeyInput body, HttpContext ctx) =>
            {
                if (string.IsNullOrWhiteSpace(body.Name)) return Results.BadRequest(new { error = "Donnez un nom à la clé (ex. le nom de l'application)." });
                var kind = body.Kind == "browser" ? "browser" : "server";
                if (kind == "browser" && (body.Origins is null || body.Origins.Count == 0))
                    return Results.BadRequest(new { error = "Une clé navigateur doit indiquer les sites autorisés (ex. https://app.mondomaine.fr)." });
                var (record, key) = auth.Keys.Create(body.Name, kind, body.Origins, ctx.User.Identity?.Name);
                return Results.Ok(new { id = record.Id, record.Name, record.Kind, record.Prefix, key });
            });

            admin.MapPost("/admin/keys/{id}/revoke", (string id) =>
                auth.Keys.Revoke(id) is null ? Results.NotFound() : Results.Ok());
        }
    }
}
