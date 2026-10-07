using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Wolflog.Client.Blazor;

// Espace de noms du pipeline : UseWolflogHeatmapPreview() est disponible sans "using" supplémentaire.
namespace Microsoft.AspNetCore.Builder;

/// <summary>
/// Aperçu des cartes de chaleur : autorise Wolflog (et lui seul) à afficher les pages en iframe, et sert la page
/// <see cref="ViewerPath"/> qui affiche la carte sur le site lui-même, pour les pages protégées par une connexion.
/// </summary>
public static class WolflogHeatmapPreviewExtensions
{
    /// <summary>
    /// Carte sur le site (« Ouvrir sur le site » dans Wolflog) : les pages s'y affichent avec la session de la personne,
    /// ce que l'iframe de Wolflog ne permet pas quand Wolflog est sur un autre site (le navigateur n'y envoie pas le cookie).
    /// </summary>
    public const string ViewerPath = "/_wolflog/heatmap";

    extension(IApplicationBuilder app)
    {
        /// <summary>
        /// Blazor (.NET 10) et l'antiforgery interdisent l'affichage en iframe (anti-clickjacking) : pour les requêtes
        /// d'iframe uniquement, ajoute l'origine du serveur Wolflog à <c>frame-ancestors</c>. La navigation normale garde sa protection.
        /// Sert aussi <see cref="ViewerPath"/>, la carte affichée sur le site, et relaie le script navigateur (/_wolflog/wolflog-rum.js)
        /// et ses envois : le navigateur ne s'adresse qu'au site (Wolflog en HTTP ou sans certificat reconnu compris). À placer
        /// avant <c>app.UseAntiforgery()</c> et avant un middleware d'authentification maison.
        /// Utilisable dans toute application ASP.NET Core (MVC, Razor Pages…) : sans AddWolflogBlazor(), l'adresse du serveur
        /// Wolflog est lue dans la configuration (Wolflog:Endpoint).
        /// </summary>
        public IApplicationBuilder UseWolflogHeatmapPreview() => app.Use(async (ctx, next) =>
        {
            var endpoint = ctx.RequestServices.GetRequiredService<IOptions<WolflogBlazorOptions>>().Value.Endpoint
                ?? ctx.RequestServices.GetService<IConfiguration>()?["Wolflog:Endpoint"];
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var wolflog) || wolflog.Scheme is not ("http" or "https"))
            {
                await next(ctx);
                return;
            }
            if (await SiteRelay.TryHandleAsync(ctx, wolflog)) return;
            if (ctx.Request.Headers["Sec-Fetch-Dest"] == "iframe")
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
