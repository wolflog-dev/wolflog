namespace Wolflog.Server.Api;

/// <summary>Interface Angular : embarquée dans le binaire (ou dossier wwwroot physique s'il existe, pratique en dev).</summary>
public static class UiEndpoints
{
    extension(WebApplication app)
    {
        public void MapWolflogUi()
        {
            var ui = UiFiles.Create(app.Logger);
            if (ui is null)
            {
                app.MapGet("/", () => Results.Text("Wolflog est démarré, mais l'interface n'a pas été construite (dossier ui/).", "text/plain; charset=utf-8"));
                return;
            }

            app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = ui });
            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = ui,
                // Les fichiers générés par Angular ont un hash dans leur nom : cache long. index.html : jamais en cache.
                OnPrepareResponse = ctx =>
                    ctx.Context.Response.Headers.CacheControl = ctx.File.Name == "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
            });
            // Routes de l'interface (/logs, /map…) : index.html ; les routes d'API inconnues restent en 404.
            app.MapFallback(async ctx =>
            {
                if (ctx.Request.Path.StartsWithSegments("/api") || ctx.Request.Path.StartsWithSegments("/v1"))
                {
                    ctx.Response.StatusCode = 404;
                    return;
                }
                ctx.Response.ContentType = "text/html; charset=utf-8";
                ctx.Response.Headers.CacheControl = "no-cache";
                await using var index = ui.GetFileInfo("index.html").CreateReadStream();
                await index.CopyToAsync(ctx.Response.Body);
            }).AllowAnonymous();
        }
    }
}
