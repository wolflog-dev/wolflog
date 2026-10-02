using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace Wolflog.Server.Api;

/// <summary>
/// Connexion unique : boutons de la page de connexion (/api/auth/sso, /api/auth/windows) et réglages de l'administration
/// (Microsoft Entra ID, Windows, création des comptes). Le secret client n'est jamais renvoyé.
/// </summary>
public static class SsoEndpoints
{
    /// <summary>Réglages envoyés par l'interface. Secret client vide : celui enregistré est conservé.</summary>
    public sealed record SettingsInput(bool MicrosoftEnabled, string? Tenant, string? ClientId, string? ClientSecret, string? ButtonLabel,
        bool WindowsEnabled, string? AutoSignIn, List<string>? AllowedDomains, string? DefaultRole, string? DefaultProfileId,
        List<SsoGroupMapping>? GroupMappings, LdapEndpoints.LdapInput? Ldap = null);

    /// <summary>Inscription Entra ID à vérifier. Secret vide : celui enregistré.</summary>
    public sealed record TestInput(string? Tenant, string? ClientId, string? ClientSecret);

    extension(WebApplication app)
    {
        public void MapWolflogSso(RouteGroupBuilder authGroup, RouteGroupBuilder admin)
        {
            var auth = app.Services.GetRequiredService<AuthService>();
            var store = app.Services.GetRequiredService<SsoSettingsStore>();
            var sso = app.Services.GetRequiredService<SsoSchemes>();

            // ------------------------------------------------------------ page de connexion
            // OpenID Connect : Microsoft Entra ID réglé dans l'interface, ou fournisseur de wolflog.json.
            authGroup.MapGet("/sso", (HttpContext ctx, string? returnUrl) =>
            {
                if (sso.OidcScheme is not { } scheme) return Results.NotFound();
                ctx.Response.Cookies.Delete(SsoSchemes.SignedOutCookie);
                return Results.Challenge(new AuthenticationProperties { RedirectUri = LocalUrl(returnUrl), IsPersistent = true }, [scheme]);
            });

            // Windows : 401 + WWW-Authenticate ; le navigateur répond avec la session Windows (sans rien demander en zone intranet).
            authGroup.MapGet("/windows", async (HttpContext ctx, string? returnUrl) =>
            {
                if (!sso.WindowsActive) return Results.NotFound();
                var result = await ctx.AuthenticateAsync(SsoSchemes.Windows);
                if (!result.Succeeded || result.Principal is not { } principal)
                {
                    await ctx.ChallengeAsync(SsoSchemes.Windows);
                    // Page affichée si le navigateur ne peut pas répondre (PC hors domaine, demande d'identifiants annulée).
                    return Results.Content(WindowsFallback, "text/html; charset=utf-8", statusCode: StatusCodes.Status401Unauthorized);
                }
                var identity = DirectoryIdentity.FromWindows(principal);
                var outcome = identity is null
                    ? new SsoProvisioning.Result(null, SsoProvisioning.NoIdentity)
                    : SsoProvisioning.Provision(auth.Users, identity, store.Current.Rules());
                if (outcome.User is null)
                {
                    store.RecordFailure(SsoSchemes.Windows, $"{identity?.Username ?? "?"} : {SsoProvisioning.Explain(outcome.Refusal)}.");
                    return Results.Redirect("/login?sso=" + outcome.Refusal);
                }
                await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, SessionPrincipal.Create(outcome.User),
                    new AuthenticationProperties { IsPersistent = true });
                ctx.Response.Cookies.Delete(SsoSchemes.SignedOutCookie);
                return Results.Redirect(LocalUrl(returnUrl));
            });

            // ------------------------------------------------------------ administration
            admin.MapGet("/admin/sso", (HttpContext ctx, NotificationSettingsStore notifications) => Results.Ok(View(ctx, auth, store, sso, notifications)));

            admin.MapPut("/admin/sso", (HttpContext ctx, SettingsInput body, NotificationSettingsStore notifications, AccessProfileStore profiles) =>
            {
                var (settings, error) = Validate(ctx, body, auth, store, profiles);
                if (settings is null) return Results.BadRequest(new { error });
                settings.UpdatedAt = DateTime.UtcNow;
                settings.UpdatedBy = ctx.User.Identity?.Name;
                store.Upsert(settings);
                sso.Sync(ctx);
                return Results.Ok(View(ctx, auth, store, sso, notifications));
            });

            // Vérification du locataire, de l'application et du secret, sans rien enregistrer.
            admin.MapPost("/admin/sso/test", async (TestInput body, IHttpClientFactory http, CancellationToken ct) =>
            {
                var secret = string.IsNullOrWhiteSpace(body.ClientSecret) ? store.ClientSecret(store.Current) : body.ClientSecret.Trim();
                return Results.Ok(await EntraCheck.RunAsync(http.CreateClient("sso"), body.Tenant, body.ClientId, secret, ct));
            });

            // Annuaire LDAP / Active Directory : test de la connexion et d'un compte.
            app.MapWolflogLdap(admin);
        }
    }

    /// <summary>Déconnexion volontaire : pas de connexion automatique avant la fermeture du navigateur.</summary>
    public static void RememberSignOut(HttpContext ctx) => ctx.Response.Cookies.Append(SsoSchemes.SignedOutCookie, "1",
        new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = ctx.Request.IsHttps, IsEssential = true });

    /// <summary>Réglages (sans le secret), méthodes actives, adresse de retour à déclarer chez Microsoft, prise en charge de Windows.</summary>
    private static object View(HttpContext ctx, AuthService auth, SsoSettingsStore store, SsoSchemes sso, NotificationSettingsStore notifications)
    {
        var s = store.Current;
        var file = auth.Oidc;
        var publicUrl = notifications.Current.PublicUrl;
        var requestRedirectUri = $"{ctx.Request.Scheme}://{ctx.Request.Host}{ctx.Request.PathBase}{OidcSignIn.CallbackPath}";
        return new
        {
            settings = new
            {
                s.MicrosoftEnabled, s.Tenant, s.ClientId,
                hasSecret = !string.IsNullOrEmpty(s.ProtectedClientSecret),
                secretUnreadable = !string.IsNullOrEmpty(s.ProtectedClientSecret) && store.ClientSecret(s) is null,
                s.ButtonLabel, s.WindowsEnabled, s.AutoSignIn, s.AllowedDomains, s.DefaultRole, s.DefaultProfileId, s.GroupMappings,
                ldap = LdapEndpoints.View(s.Ldap, store),
                s.UpdatedAt, s.UpdatedBy,
            },
            active = new { microsoft = sso.MicrosoftActive, windows = sso.WindowsActive, ldap = s.Ldap.Enabled && s.Ldap.IsComplete() },
            // Section Oidc de wolflog.json : prioritaire, affichée en lecture seule.
            file = file is null ? null : new
            {
                file.Authority, file.ClientId, file.DisplayName, file.DefaultRole, file.GroupsClaim, file.AdminGroups, file.EditorGroups,
                microsoft = OidcSignIn.IsMicrosoft(file.Authority),
            },
            // Adresse envoyée à Microsoft : l'adresse publique (Alertes > Canaux) si elle est renseignée, sinon celle de la requête.
            redirectUri = (file is null ? OidcSignIn.RedirectUri(publicUrl) : null) ?? requestRedirectUri,
            requestRedirectUri,
            publicUrl,
            windowsHost = SsoSchemes.WindowsSupport(ctx),
            lastFailure = store.LastFailure,
        };
    }

    private static (SsoSettings? Settings, string? Error) Validate(HttpContext ctx, SettingsInput body, AuthService auth, SsoSettingsStore store, AccessProfileStore profiles)
    {
        var current = store.Current;
        var s = new SsoSettings
        {
            MicrosoftEnabled = body.MicrosoftEnabled,
            Tenant = SsoSettings.NormalizeTenant(body.Tenant),
            ClientId = string.IsNullOrWhiteSpace(body.ClientId) ? null : body.ClientId.Trim().ToLowerInvariant(),
            // Secret vide : celui enregistré est conservé (il n'est jamais renvoyé à l'interface).
            ProtectedClientSecret = string.IsNullOrWhiteSpace(body.ClientSecret) ? current.ProtectedClientSecret : store.ProtectSecret(body.ClientSecret.Trim()),
            ButtonLabel = string.IsNullOrWhiteSpace(body.ButtonLabel) ? "Microsoft" : body.ButtonLabel.Trim(),
            WindowsEnabled = body.WindowsEnabled,
            DefaultRole = body.DefaultRole ?? Roles.Viewer,
        };
        if (s.ButtonLabel.Length > 40) return (null, "Texte du bouton : 40 caractères au plus.");
        if (!Roles.IsValid(s.DefaultRole)) return (null, "Rôle par défaut inconnu.");
        // Profil par défaut : « Tout voir » (ou aucun) est enregistré comme null, un profil inconnu est refusé.
        if (!profiles.TryResolve(body.DefaultProfileId ?? "", out var defaultProfile))
            return (null, $"Le profil d'accès par défaut « {body.DefaultProfileId!.Trim()} » n'existe pas (supprimé entre-temps ?) : choisissez-en un autre.");
        s.DefaultProfileId = defaultProfile;

        // Microsoft : réglages incomplets acceptés tant que la connexion est désactivée (brouillon), jamais un locataire invalide.
        // Avec la section Oidc de wolflog.json, prioritaire, ces réglages restent enregistrés mais ne servent pas.
        var microsoftUsed = s.MicrosoftEnabled && auth.Oidc is null;
        if ((s.Tenant is not null || microsoftUsed) && SsoSettings.TenantError(s.Tenant) is { } tenantError) return (null, tenantError);
        if (s.ClientId is not null && !Guid.TryParse(s.ClientId, out _))
            return (null, "L'ID d'application (client) est un GUID : copiez-le depuis la page « Vue d'ensemble » de l'inscription.");
        if (microsoftUsed)
        {
            if (s.ClientId is null) return (null, "Indiquez l'ID d'application (client) de l'inscription.");
            if (s.ProtectedClientSecret is null) return (null, "Indiquez le secret client (sa « Valeur », dans Certificats et secrets).");
            if (store.ClientSecret(s) is null)
                return (null, "Le secret client enregistré ne peut plus être déchiffré (clés de chiffrement changées, ex. après un déménagement du serveur) : saisissez-le de nouveau.");
        }

        // Windows : seulement si le serveur web sait authentifier les sessions Windows, sinon chaque connexion échouerait.
        if (s.WindowsEnabled && SsoSchemes.WindowsSupport(ctx) is { Supported: false } host) return (null, host.Message);

        // Annuaire LDAP / Active Directory : vérifié dès qu'il est activé ; sans réglages envoyés, ceux enregistrés restent.
        var (ldap, ldapError) = LdapEndpoints.Read(body.Ldap, current.Ldap, store, LdapEndpoints.Check.Save);
        if (ldap is null) return (null, ldapError);
        s.Ldap = ldap;

        foreach (var value in body.AllowedDomains ?? [])
        {
            if (string.IsNullOrWhiteSpace(value)) continue;
            if (SsoSettings.NormalizeDomain(value) is not { } domain)
                return (null, $"Domaine invalide : « {value.Trim()} » (ex. contoso.fr, ou CONTOSO pour un domaine Windows).");
            if (!s.AllowedDomains.Contains(domain)) s.AllowedDomains.Add(domain);
        }

        foreach (var m in body.GroupMappings ?? [])
        {
            var group = m.Group?.Trim() ?? "";
            if (group.Length == 0) continue;
            var role = string.IsNullOrWhiteSpace(m.Role) ? null : m.Role.Trim();
            var profile = string.IsNullOrWhiteSpace(m.ProfileId) ? null : m.ProfileId.Trim();
            if (role is not null && !Roles.IsValid(role)) return (null, $"Rôle inconnu pour le groupe « {group} ».");
            // « Tout voir » reste explicite ici : le groupe élargit alors un profil par défaut restreint.
            if (profile is not null && !profiles.TryResolve(profile, out _))
                return (null, $"Le profil d'accès « {profile} » du groupe « {group} » n'existe pas (supprimé entre-temps ?) : choisissez-en un autre.");
            if (role is null && profile is null) return (null, $"Le groupe « {group} » ne donne ni rôle ni profil : choisissez au moins l'un des deux.");
            if (s.GroupMappings.Any(x => string.Equals(x.Group, group, StringComparison.OrdinalIgnoreCase))) return (null, $"Le groupe « {group} » figure deux fois.");
            s.GroupMappings.Add(new SsoGroupMapping { Group = group, Name = string.IsNullOrWhiteSpace(m.Name) ? null : m.Name.Trim(), Role = role, ProfileId = profile });
        }
        if (s.GroupMappings.Count > 200) return (null, "200 correspondances de groupes au plus.");

        // Connexion automatique : seulement vers une méthode active.
        s.AutoSignIn = body.AutoSignIn switch
        {
            SsoSchemes.Microsoft when s.MicrosoftEnabled || auth.Oidc is not null => SsoSchemes.Microsoft,
            SsoSchemes.Windows when s.WindowsEnabled => SsoSchemes.Windows,
            _ => "",
        };
        return (s, null);
    }

    /// <summary>Adresse de retour locale uniquement (« /logs ») : jamais « //site » ni une adresse absolue (redirection ouverte).</summary>
    private static string LocalUrl(string? url) =>
        url is { Length: > 0 } && url[0] == '/' && (url.Length == 1 || (url[1] != '/' && url[1] != '\\')) && !url.Any(char.IsControl) ? url : "/";

    /// <summary>Page montrée par le navigateur quand il ne peut pas transmettre de session Windows.</summary>
    private const string WindowsFallback = """
        <!doctype html>
        <html lang="fr">
        <head>
          <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Connexion Windows · Wolflog</title>
          <style>
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
              font: 14px/1.55 system-ui, 'Segoe UI', sans-serif; color: #1c2433; background: #eef3fb; }
            main { max-width: 420px; padding: 26px 28px; border-radius: 20px; background: #fff; box-shadow: 0 18px 44px -22px rgb(0 0 0 / .45); }
            h1 { margin: 0 0 8px; font-size: 18px; }
            p { margin: 0 0 16px; }
            a { display: inline-block; padding: 9px 16px; border-radius: 11px; color: #fff; background: #2563eb; font-weight: 600; text-decoration: none; }
            @media (prefers-color-scheme: dark) { body { color: #e6ecf7; background: #0b1220; } main { background: #141d2f; } }
          </style>
        </head>
        <body>
          <main>
            <h1>Connexion Windows impossible</h1>
            <p>Votre navigateur n'a pas transmis votre session Windows : ordinateur hors du domaine, demande d'identifiants annulée,
              ou adresse de Wolflog absente de la zone « Intranet local ».</p>
            <a href="/login?sso=windows">Revenir à la connexion</a>
          </main>
        </body>
        </html>
        """;
}
