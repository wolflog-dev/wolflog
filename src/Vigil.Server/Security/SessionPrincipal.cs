using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;

namespace Vigil.Server.Security;

/// <summary>Identité de session (cookie) construite depuis un compte Vigil, local ou SSO.</summary>
public static class SessionPrincipal
{
    public const string OidcScheme = "oidc";
    public const string UserIdClaim = "vigil:uid";

    public static ClaimsPrincipal Create(User user) => new(new ClaimsIdentity(
    [
        new Claim(ClaimTypes.Name, user.Username),
        new Claim(ClaimTypes.Role, user.Role),
        new Claim(UserIdClaim, user.Id),
        new Claim("vigil:display", user.DisplayName ?? user.Username),
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

    public static void ConfigureOidc(OpenIdConnectOptions o, VigilServerOptions.OidcOptions cfg)
    {
        o.Authority = cfg.Authority;
        o.ClientId = cfg.ClientId;
        o.ClientSecret = cfg.ClientSecret;
        o.ResponseType = "code";
        o.UsePkce = true;
        o.SaveTokens = false;
        o.CallbackPath = "/signin-oidc";
        o.SignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
        o.Scope.Clear();
        foreach (var scope in new[] { "openid", "profile", "email" }) o.Scope.Add(scope);
        o.MapInboundClaims = false;
        o.Events.OnTokenValidated = ctx =>
        {
            // Compte Vigil créé ou mis à jour à partir de l'annuaire ; rôle déduit des groupes.
            var principal = ctx.Principal!;
            var username = principal.FindFirst("preferred_username")?.Value ?? principal.FindFirst("email")?.Value
                           ?? principal.FindFirst("name")?.Value ?? principal.FindFirst("sub")!.Value;
            var groups = principal.FindAll(cfg.GroupsClaim).Concat(principal.FindAll("roles")).Select(c => c.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
            string? directoryRole = cfg.AdminGroups.Any(groups.Contains) ? Roles.Admin : cfg.EditorGroups.Any(groups.Contains) ? Roles.Editor : null;

            var auth = ctx.HttpContext.RequestServices.GetRequiredService<AuthService>();
            var user = auth.Users.ByUsername(username) ?? new User
            {
                Username = username,
                Source = "sso",
                Role = Roles.IsValid(cfg.DefaultRole) ? cfg.DefaultRole : Roles.Viewer,
            };
            if (user.Disabled)
            {
                ctx.Fail("Compte désactivé dans Vigil.");
                return Task.CompletedTask;
            }
            user.DisplayName = principal.FindFirst("name")?.Value ?? user.DisplayName;
            user.Email = principal.FindFirst("email")?.Value ?? user.Email;
            if (directoryRole != null) user.Role = directoryRole;
            user.LastLoginAt = DateTime.UtcNow;
            user = auth.Users.Upsert(user);
            ctx.Principal = Create(user);
            return Task.CompletedTask;
        };
        o.Events.OnRemoteFailure = ctx =>
        {
            ctx.Response.Redirect("/login?sso=error");
            ctx.HandleResponse();
            return Task.CompletedTask;
        };
    }
}
