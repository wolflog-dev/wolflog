using System.Text.RegularExpressions;
using Wolflog.Client.Blazor;

// Espace de noms du pipeline : UseWolflogHeatmapPreview() est disponible sans "using" supplémentaire.
namespace Microsoft.AspNetCore.Builder;

/// <summary>Aperçu des cartes de chaleur : autorise Wolflog (et lui seul) à afficher les pages en iframe.</summary>
public static class WolflogHeatmapPreviewExtensions
{
    extension(IApplicationBuilder app)
    {
        /// <summary>
        /// Blazor (.NET 10) et l'antiforgery interdisent l'affichage en iframe (anti-clickjacking) : pour les requêtes
        /// d'iframe uniquement, ajoute l'origine du serveur Wolflog à <c>frame-ancestors</c>. La navigation normale garde sa protection.
        /// À placer avant <c>app.UseAntiforgery()</c>.
        /// </summary>
        public IApplicationBuilder UseWolflogHeatmapPreview() => app.Use(async (ctx, next) =>
        {
            var endpoint = ctx.RequestServices.GetRequiredService<IOptions<WolflogBlazorOptions>>().Value.Endpoint;
            if (ctx.Request.Headers["Sec-Fetch-Dest"] == "iframe" && Uri.TryCreate(endpoint, UriKind.Absolute, out var wolflog))
            {
                var origin = wolflog.GetLeftPart(UriPartial.Authority);
                // Exécuté juste avant l'envoi : les en-têtes posés par Blazor et l'antiforgery sont alors connus.
                ctx.Response.OnStarting(() =>
                {
                    var headers = ctx.Response.Headers;
                    headers.Remove("X-Frame-Options");
                    var csp = headers.ContentSecurityPolicy.ToString();
                    if (csp.Length == 0)
                        headers.ContentSecurityPolicy = $"frame-ancestors 'self' {origin}";
                    else if (!csp.Contains(origin, StringComparison.OrdinalIgnoreCase))
                        headers.ContentSecurityPolicy = csp.Contains("frame-ancestors", StringComparison.Ordinal)
                            ? Regex.Replace(csp, "frame-ancestors([^;]*)", m => "frame-ancestors" + m.Groups[1].Value.Replace("'none'", "'self'").TrimEnd() + " " + origin)
                            : csp.TrimEnd(' ', ';') + $"; frame-ancestors 'self' {origin}";
                    return Task.CompletedTask;
                });
            }
            await next(ctx);
        });
    }
}
