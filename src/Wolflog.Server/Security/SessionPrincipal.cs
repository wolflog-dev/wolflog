using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;

namespace Wolflog.Server.Security;

/// <summary>Identité de session (cookie) construite depuis un compte Wolflog, local ou SSO.</summary>
public static class SessionPrincipal
{
    public const string OidcScheme = "oidc";
    public const string UserIdClaim = "wolflog:uid";

    public static ClaimsPrincipal Create(User user) => new(new ClaimsIdentity(
    [
        new Claim(ClaimTypes.Name, user.Username),
        new Claim(ClaimTypes.Role, user.Role),
        new Claim(UserIdClaim, user.Id),
        new Claim("wolflog:display", user.DisplayName ?? user.Username),
    ], CookieAuthenticationDefaults.AuthenticationScheme));

    public static string? Role(this ClaimsPrincipal p) => p.FindFirst(ClaimTypes.Role)?.Value;
    public static string? UserId(this ClaimsPrincipal p) => p.FindFirst(UserIdClaim)?.Value;

    /// <summary>À chaque requête : le compte existe-t-il encore, est-il actif, son rôle a-t-il changé ?</summary>
    public static async Task Refresh(CookieValidatePrincipalContext ctx)
    {
        var id = ctx.Principal?.UserId();
        var auth = ctx.HttpContext.RequestServices.GetRequiredService<AuthService>();
        var user = id is null ? null : auth.Users.Get(id);
        if (user is null || user.Disabled)
        {
            ctx.RejectPrincipal();
            await ctx.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return;
        }
        if (ctx.Principal!.Role() != user.Role || ctx.Principal!.Identity?.Name != user.Username)
        {
            ctx.ReplacePrincipal(Create(user));
            ctx.ShouldRenew = true;
        }
    }

    /// <summary>Section Oidc de wolflog.json : comptes créés comme pour la connexion réglée dans l'interface, rôle déduit des groupes.</summary>
    public static void ConfigureOidc(OpenIdConnectOptions o, WolflogServerOptions.OidcOptions cfg)
    {
        o.Authority = cfg.Authority;
        o.ClientId = cfg.ClientId;
        o.ClientSecret = cfg.ClientSecret;
        OidcSignIn.Configure(o, OidcScheme, cfg.GroupsClaim, () => OidcSignIn.FileRules(cfg));
    }
}
