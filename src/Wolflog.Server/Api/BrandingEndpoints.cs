using System.Text.RegularExpressions;
using Microsoft.Net.Http.Headers;

namespace Wolflog.Server.Api;

/// <summary>
/// Personnalisation aux couleurs d'une entreprise : nom, couleur, logo et message de la page de connexion.
/// Lecture publique (la page de connexion en a besoin), modification réservée aux administrateurs.
/// </summary>
public static partial class BrandingEndpoints
{
    public sealed record BrandingInput(string? Name, string? Color, string? LoginMessage, bool? ForcePalette);

    [GeneratedRegex("^#?(?:[0-9a-fA-F]{3}){1,2}$")]
    private static partial Regex HexColor();

    extension(WebApplication app)
    {
        public void MapWolflogBranding(RouteGroupBuilder admin)
        {
            // Hors du groupe /api authentifié, comme /api/auth : lus avant la connexion.
            app.MapGet("/api/branding", (HttpContext ctx, BrandingStore store) => Results.Ok(View(store, ctx, admin: false))).AllowAnonymous();

            app.MapGet("/api/branding/logo", (HttpContext ctx, BrandingStore store) =>
            {
                var content = store.ReadLogo();
                if (content is null || BrandingLogo.Check(content).ContentType is not { } type) return Results.NotFound();
                var version = BrandingLogo.Version(content);
                var headers = ctx.Response.Headers;
                headers.XContentTypeOptions = "nosniff";
                // Adresse versionnée (?v=empreinte du contenu) : cache d'un an. Sans version ou version dépassée : revalidée.
                headers.CacheControl = ctx.Request.Query["v"] == version ? "public, max-age=31536000, immutable" : "no-cache";
                // SVG ouvert directement dans un onglet : ni script ni ressource extérieure, quel que soit son contenu.
                if (type == BrandingLogo.Svg) headers.ContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'";
                return Results.Bytes(content, type, entityTag: new EntityTagHeaderValue($"\"{version}\""));
            }).AllowAnonymous();

            admin.MapGet("/admin/branding", (HttpContext ctx, BrandingStore store) => Results.Ok(View(store, ctx, admin: true)));

            admin.MapPut("/admin/branding", (BrandingInput body, HttpContext ctx, BrandingStore store) =>
            {
                var name = Clean(body.Name, singleLine: true);
                var color = Clean(body.Color, singleLine: true);
                var message = Clean(body.LoginMessage, singleLine: false);
                if (name?.Length > 60) return Results.BadRequest(new { error = "Nom trop long : 60 caractères au plus." });
                if (color != null && !HexColor().IsMatch(color)) return Results.BadRequest(new { error = "Couleur attendue au format #RRGGBB (ex. #0A66C2)." });
                if (message?.Length > 500) return Results.BadRequest(new { error = "Message trop long : 500 caractères au plus." });
                if (body.ForcePalette == true && color is null) return Results.BadRequest(new { error = "Choisissez une couleur pour l'imposer à tous." });
                store.Change(b =>
                {
                    b.CompanyName = name;
                    b.Color = color is null ? null : NormalizeColor(color);
                    b.LoginMessage = message;
                    b.ForcePalette = body.ForcePalette == true;
                }, ctx.User.Identity?.Name);
                return Results.Ok(View(store, ctx, admin: true));
            });

            admin.MapPost("/admin/branding/logo", async (HttpContext ctx, BrandingStore store) =>
            {
                const string tooLarge = "Logo trop lourd : 1 Mo au plus.";
                if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { error = "Envoyez le logo dans un formulaire (champ « file »)." });
                if (ctx.Request.ContentLength > BrandingLogo.MaxBytes + 64 * 1024) return Results.BadRequest(new { error = tooLarge });
                var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
                var file = form.Files.GetFile("file") ?? form.Files.FirstOrDefault();
                if (file is null || file.Length == 0) return Results.BadRequest(new { error = "Fichier manquant." });
                if (file.Length > BrandingLogo.MaxBytes) return Results.BadRequest(new { error = tooLarge });
                using var buffer = new MemoryStream();
                await file.CopyToAsync(buffer, ctx.RequestAborted);
                var content = buffer.ToArray();
                var (type, error) = BrandingLogo.Check(content);
                if (type is null) return Results.BadRequest(new { error });
                store.SetLogo(content, type, FileName(file.FileName), ctx.User.Identity?.Name);
                return Results.Ok(View(store, ctx, admin: true));
            }).DisableAntiforgery();

            admin.MapDelete("/admin/branding/logo", (HttpContext ctx, BrandingStore store) =>
            {
                store.RemoveLogo(ctx.User.Identity?.Name);
                return Results.Ok(View(store, ctx, admin: true));
            });
        }
    }

    /// <summary>
    /// Personnalisation telle que la lit l'interface (rien de confidentiel : la page de connexion l'affiche) ;
    /// les administrateurs voient en plus le fichier du logo et la dernière modification.
    /// </summary>
    private static object View(BrandingStore store, HttpContext ctx, bool admin)
    {
        var b = store.Current;
        var hasLogo = store.HasLogo(b);
        var logoUrl = hasLogo ? $"{ctx.Request.PathBase}/api/branding/logo?v={b.LogoVersion}" : null;
        var forcePalette = b.ForcePalette && b.Color != null;
        return admin
            ? new { name = b.CompanyName, b.Color, hasLogo, logoUrl, b.LoginMessage, forcePalette, b.LogoFileName, b.LogoContentType, b.LogoSize, b.UpdatedAt, b.UpdatedBy }
            : new { name = b.CompanyName, b.Color, hasLogo, logoUrl, b.LoginMessage, forcePalette };
    }

    /// <summary>Texte saisi sans espaces autour (null si vide) ; nom sur une seule ligne.</summary>
    private static string? Clean(string? value, bool singleLine)
    {
        var text = value?.Replace("\r\n", "\n").Trim();
        if (singleLine) text = text is null ? null : string.Join(' ', text.Split(['\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        return string.IsNullOrEmpty(text) ? null : text;
    }

    /// <summary>#abc ou abc → #aabbcc ; #AABBCC → #aabbcc.</summary>
    private static string NormalizeColor(string color)
    {
        var hex = color.TrimStart('#').ToLowerInvariant();
        return "#" + (hex.Length == 3 ? string.Concat(hex.Select(c => $"{c}{c}")) : hex);
    }

    /// <summary>Nom du fichier envoyé, sans chemin, limité à 120 caractères (affiché dans la page Personnalisation).</summary>
    private static string FileName(string raw)
    {
        var name = Path.GetFileName(raw.Replace('\\', '/'));
        return name.Length > 120 ? name[..120] : name;
    }
}
