using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;

namespace Wolflog.Server.Security;

/// <summary>
/// Connexion OpenID Connect : Microsoft Entra ID réglé dans l'interface (schéma « microsoft »), ou fournisseur de la
/// section Oidc de wolflog.json (schéma « oidc »). Code + PKCE, retour sur /signin-oidc, session dans le cookie Wolflog.
/// Le compte est créé ou mis à jour à la validation du jeton ; un échec ramène à la page de connexion avec sa raison.
/// </summary>
public static class OidcSignIn
{
    public const string CallbackPath = "/signin-oidc";

    /// <summary>Réglages communs aux deux sources.</summary>
    public static void Configure(OpenIdConnectOptions o, string method, string groupsClaim, Func<SsoProvisioning.Rules> rules)
    {
        o.ResponseType = "code";
        o.UsePkce = true;
        o.SaveTokens = false;
        o.CallbackPath = CallbackPath;
        o.SignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
        o.Scope.Clear();
        foreach (var scope in new[] { "openid", "profile", "email" }) o.Scope.Add(scope);
        o.MapInboundClaims = false;
        o.Events.OnTokenValidated = ctx =>
        {
            // Compte Wolflog créé ou mis à jour à partir de l'annuaire, puis session Wolflog à la place de l'identité reçue.
            var services = ctx.HttpContext.RequestServices;
            var identity = DirectoryIdentity.FromOidc(method, ctx.Principal!, groupsClaim);
            var result = identity is null
                ? new SsoProvisioning.Result(null, SsoProvisioning.NoIdentity)
                : SsoProvisioning.Provision(services.GetRequiredService<AuthService>().Users, identity, rules());
            if (result.User is null)
            {
                services.GetRequiredService<SsoSettingsStore>().RecordFailure(method, $"{identity?.Username ?? "?"} : {SsoProvisioning.Explain(result.Refusal)}.");
                ctx.Response.Redirect("/login?sso=" + result.Refusal);
                ctx.HandleResponse();
                return Task.CompletedTask;
            }
            ctx.Principal = SessionPrincipal.Create(result.User);
            return Task.CompletedTask;
        };
        // Demande refusée ou annulée chez le fournisseur : rien d'anormal à signaler à l'administrateur.
        o.Events.OnAccessDenied = ctx =>
        {
            ctx.Response.Redirect("/login?sso=denied");
            ctx.HandleResponse();
            return Task.CompletedTask;
        };
        o.Events.OnRemoteFailure = ctx =>
        {
            ctx.HttpContext.RequestServices.GetRequiredService<SsoSettingsStore>()
                .RecordFailure(method, EntraCheck.Explain(ctx.Failure?.Message ?? "échec sans message"));
            ctx.Response.Redirect("/login?sso=error");
            ctx.HandleResponse();
            return Task.CompletedTask;
        };
    }

    /// <summary>Microsoft Entra ID réglé dans l'interface : locataire, application et secret de sso.json.</summary>
    public static void ConfigureMicrosoft(OpenIdConnectOptions o, SsoSettingsStore store, NotificationSettingsStore notifications, IHttpClientFactory http)
    {
        var s = store.Current;
        o.Authority = SsoSettings.AuthorityOf(s.Tenant ?? "");
        o.ClientId = s.ClientId;
        o.ClientSecret = store.ClientSecret(s);
        o.Backchannel = http.CreateClient("sso");
        Configure(o, SsoSchemes.Microsoft, "groups", () => store.Current.Rules());
        // Adresse de retour : l'adresse publique de Wolflog si elle est renseignée (Alertes > Canaux), indispensable derrière
        // un reverse proxy ; sinon celle de la requête.
        o.Events.OnRedirectToIdentityProvider = ctx =>
        {
            if (RedirectUri(notifications.Current.PublicUrl) is { } uri) ctx.ProtocolMessage.RedirectUri = uri;
            return Task.CompletedTask;
        };
    }

    /// <summary>Règles de la section Oidc de wolflog.json : groupes administrateurs et éditeurs, rôle par défaut.</summary>
    public static SsoProvisioning.Rules FileRules(WolflogServerOptions.OidcOptions cfg) => new(
        cfg.DefaultRole, null, [],
        [
            .. cfg.AdminGroups.Select(g => new SsoGroupMapping { Group = g, Role = Roles.Admin }),
            .. cfg.EditorGroups.Select(g => new SsoGroupMapping { Group = g, Role = Roles.Editor }),
        ],
        FollowDirectory: false);

    /// <summary>Adresse de retour pour une adresse publique (https://wolflog.contoso.fr → …/signin-oidc) ; null si elle n'est pas utilisable.</summary>
    public static string? RedirectUri(string? publicUrl) =>
        Uri.TryCreate(publicUrl?.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? uri.GetLeftPart(UriPartial.Path).TrimEnd('/') + CallbackPath
            : null;

    /// <summary>Fournisseur Microsoft (cloud mondial ou souverain) : bouton avec le logo Microsoft.</summary>
    public static bool IsMicrosoft(string authority) =>
        Uri.TryCreate(authority, UriKind.Absolute, out var uri)
        && (uri.Host.EndsWith("microsoftonline.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.EndsWith("microsoftonline.us", StringComparison.OrdinalIgnoreCase)
            || uri.Host.EndsWith("chinacloudapi.cn", StringComparison.OrdinalIgnoreCase));
}
