namespace Wolflog.Server.Api;

/// <summary>
/// Profils d'accès : contrôle de chaque appel de l'API (la partie de Wolflog dont relève la route, voir <see cref="ApiSections"/>,
/// doit figurer dans le profil de la personne connectée) et administration des profils (/api/admin/access-profiles).
/// </summary>
public static class AccessEndpoints
{
    /// <summary>
    /// Saisie d'un profil ; en modification, un champ absent (null) reste inchangé. Services : noms ou motifs (« boutique-* »),
    /// liste vide = tous.
    /// </summary>
    public sealed record ProfileInput(string? Name, string? Description, string? Icon, List<string>? Sections, string? Home, List<string>? Services = null);

    /// <summary>Routes sans partie déjà signalées dans le journal (une fois chacune).</summary>
    private static readonly ConcurrentDictionary<string, bool> Unclassified = new();

    extension(WebApplication app)
    {
        public void MapWolflogAccess(RouteGroupBuilder api, RouteGroupBuilder admin)
        {
            var auth = app.Services.GetRequiredService<AuthService>();
            var profiles = app.Services.GetRequiredService<AccessProfileStore>();
            var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(AccessEndpoints));

            // Compte et profil relus à chaque appel (collections en mémoire) : un changement de profil s'applique aussitôt.
            api.AddEndpointFilter(async (ictx, next) =>
            {
                var ctx = ictx.HttpContext;
                if (!auth.Enabled || ctx.User.UserId() is not { } uid || auth.Users.Get(uid) is not { } user
                    || AccessProfileStore.SeesEverything(user)) return await next(ictx);
                var grant = profiles.GrantFor(user);
                var route = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? ctx.Request.Path.Value ?? "";
                var sections = ApiSections.For(route, ctx.Request.Method, ctx.Request.Query);
                if (sections is null && Unclassified.TryAdd(route, true))
                    log.LogWarning("Route {Route} rattachée à aucune partie de Wolflog (ApiSections) : refusée aux profils d'accès restreints.", route);
                if (sections is null || (sections.Length > 0 && !sections.Any(grant.Allows))) return Forbidden(grant, sections);
                // Services visibles : appliqués à toutes les requêtes de données (QueryService) et aux objets rattachés à un service.
                ctx.SetAccess(grant);
                if (!grant.Services.IsAll) ctx.RequestServices.GetRequiredService<QueryService>().Scope = grant.Services;
                return await next(ictx);
            });

            admin.MapGet("/admin/access-profiles", () =>
            {
                var users = auth.Users.All();
                return Results.Ok(profiles.All().OrderBy(p => Rank(p.Id)).ThenBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase).Select(p => View(p, users)));
            });

            admin.MapPost("/admin/access-profiles", (ProfileInput body) =>
            {
                var profile = new AccessProfile();
                if (Apply(profile, body, profiles) is { } error) return Results.BadRequest(new { error });
                profile.Id = NewId(profile.Name, profiles);
                profiles.Upsert(profile);
                return Results.Ok(View(profile, auth.Users.All()));
            });

            admin.MapPut("/admin/access-profiles/{id}", (string id, ProfileInput body) =>
            {
                var profile = profiles.Get(id);
                if (profile is null) return Results.NotFound();
                if (Apply(profile, body, profiles) is { } error) return Results.BadRequest(new { error });
                profiles.Upsert(profile);
                return Results.Ok(View(profile, auth.Users.All()));
            });

            admin.MapDelete("/admin/access-profiles/{id}", (string id, HttpContext ctx) =>
            {
                var profile = profiles.Get(id);
                if (profile is null) return Results.NotFound();
                if (profile.Builtin) return Results.BadRequest(new { error = "Les profils fournis par Wolflog ne se suppriment pas (ils restent modifiables)." });
                // Connexion unique : profil des nouveaux comptes ou d'un groupe de l'annuaire (sinon, ils n'auraient plus rien à voir).
                if (ctx.RequestServices.GetService<SsoSettingsStore>()?.Current is { } sso
                    && (sso.DefaultProfileId == id || sso.GroupMappings.Any(m => m.ProfileId == id)))
                    return Results.BadRequest(new { error = "Ce profil est attribué par la connexion unique (profil par défaut ou groupe de l'annuaire) : changez d'abord ses réglages." });
                var users = auth.Users.All();
                // Refus plutôt qu'un retour à « Tout voir » : supprimer un profil ne doit jamais élargir l'accès de quelqu'un.
                var assigned = users.Count(u => Applies(profile, u));
                if (assigned > 0)
                    return Results.BadRequest(new { error = $"Ce profil est attribué à {assigned} utilisateur{(assigned > 1 ? "s" : "")} : attribuez-leur un autre profil avant de le supprimer." });
                // Administrateurs : le profil était sans effet sur eux, il est simplement oublié.
                foreach (var u in users.Where(u => u.ProfileId == id)) auth.Users.Update(u.Id, x => x.ProfileId = null);
                profiles.Delete(id);
                return Results.Ok();
            });
        }
    }

    private static IResult Forbidden(AccessGrant grant, string[]? sections)
    {
        var error = grant.Sections.Count == 0
            ? "Votre profil d'accès n'existe plus : demandez à un administrateur de vous en attribuer un."
            : $"Votre profil d'accès « {grant.Profile?.Name} » ne donne pas accès à {(sections is { Length: > 0 } ? $"« {AccessSections.Label(sections[0])} »" : "cette partie de Wolflog")}.";
        return Results.Json(new { error, section = sections?.FirstOrDefault() }, statusCode: StatusCodes.Status403Forbidden);
    }

    /// <summary>Vue d'un profil pour l'administration : parties visibles, page d'accueil et nombre de comptes concernés.</summary>
    private static object View(AccessProfile p, List<User> users) => new
    {
        p.Id, p.Name, p.Description, p.Icon, p.Builtin,
        sections = AccessProfileStore.SectionsOf(p),
        home = AccessProfileStore.HomeOf(p),
        services = AccessProfileStore.ServicesOf(p),
        users = users.Count(u => Applies(p, u)),
    };

    /// <summary>Le profil s'applique au compte (sans profil : « Tout voir ») ; jamais à un administrateur, qui voit tout.</summary>
    private static bool Applies(AccessProfile p, User u) =>
        u.Role != Roles.Admin && (string.IsNullOrEmpty(u.ProfileId) ? AccessProfileStore.Everything : u.ProfileId) == p.Id;

    /// <summary>Profils fournis en tête, dans l'ordre (tout voir, produit, exploitation), puis les autres par nom.</summary>
    internal static int Rank(string id) => id switch
    {
        AccessProfileStore.Everything => 0,
        AccessProfileStore.Product => 1,
        AccessProfileStore.Ops => 2,
        _ => 3,
    };

    /// <summary>Applique la saisie au profil ; message d'erreur si elle n'est pas valable (le profil n'est alors pas modifié).</summary>
    private static string? Apply(AccessProfile p, ProfileInput body, AccessProfileStore profiles)
    {
        var name = (body.Name ?? p.Name).Trim();
        if (name.Length == 0) return "Donnez un nom au profil.";
        if (name.Length > 60) return "Nom trop long (60 caractères au plus).";
        if (profiles.All().Any(x => x.Id != p.Id && string.Equals(x.Name.Trim(), name, StringComparison.OrdinalIgnoreCase)))
            return $"Un profil s'appelle déjà « {name} ».";
        var description = (body.Description ?? p.Description)?.Trim();
        if (description?.Length > 300) return "Description trop longue (300 caractères au plus).";

        // « Tout voir » donne toujours accès à tout, y compris aux parties des prochaines versions.
        var requested = p.Id == AccessProfileStore.Everything ? [.. AccessSections.All] : body.Sections ?? p.Sections;
        if (requested.FirstOrDefault(s => !AccessSections.IsValid(s)) is { } unknown) return $"Partie de Wolflog inconnue : « {unknown} ».";
        var sections = AccessSections.Normalize(requested);
        if (sections.Count == 0) return "Cochez au moins une partie de Wolflog.";
        var home = string.IsNullOrWhiteSpace(body.Home) ? null : body.Home.Trim();
        if (home is not null && !sections.Contains(home)) return "La page d'accueil doit être l'une des parties visibles.";
        // Services : « Tout voir » les voit toujours tous ; ailleurs, liste vide = tous.
        var services = p.Id == AccessProfileStore.Everything ? [] : body.Services ?? p.Services;
        if (ServiceScope.Validate(services) is { } invalid) return invalid;

        var icon = (body.Icon ?? p.Icon)?.Trim();
        p.Name = name;
        p.Description = string.IsNullOrEmpty(description) ? null : description;
        p.Icon = icon is { Length: > 0 and <= 32 } && icon.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-') ? icon : null;
        p.Sections = sections;
        p.Services = ServiceScope.Normalize(services);
        // Page d'accueil inchangée tant qu'elle reste visible ; sinon la première partie.
        p.Home = home ?? (p.Home is { } current && sections.Contains(current) ? current : sections[0]);
        return null;
    }

    /// <summary>Identifiant lisible tiré du nom, unique : « Équipe support » → equipe-support (repris dans les adresses et la configuration).</summary>
    private static string NewId(string name, AccessProfileStore profiles)
    {
        var slug = new StringBuilder();
        foreach (var ch in name.ToLowerInvariant())
        {
            var c = ch switch
            {
                'à' or 'â' or 'ä' => 'a', 'é' or 'è' or 'ê' or 'ë' => 'e', 'î' or 'ï' => 'i', 'ô' or 'ö' => 'o',
                'ù' or 'û' or 'ü' => 'u', 'ç' => 'c', _ => ch,
            };
            if (char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c)) slug.Append(c);
            else if (slug.Length > 0 && slug[^1] != '-') slug.Append('-');
        }
        var stem = slug.ToString().Trim('-');
        if (stem.Length > 32) stem = stem[..32].TrimEnd('-');
        if (stem.Length == 0) stem = "profil";
        var id = stem;
        for (var i = 2; profiles.Get(id) is not null; i++) id = $"{stem}-{i}";
        return id;
    }
}
