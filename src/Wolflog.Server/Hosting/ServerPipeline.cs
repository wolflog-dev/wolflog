namespace Wolflog.Server.Hosting;

/// <summary>Chaîne de traitement des requêtes et routes du serveur.</summary>
public static class ServerPipeline
{
    extension(WebApplication app)
    {
        public WebApplication UseWolflogServer()
        {
            // Vérifie les identifiants dès le démarrage (et les affiche au premier lancement).
            app.Services.GetRequiredService<AuthService>();

            app.UseResponseCompression();
            app.UseMiddleware<IngestKeyMiddleware>();
            app.UseAuthentication();
            app.UseAuthorization();

            app.MapOtlpIngestion();
            app.MapWolflogApi();
            app.MapWolflogUi();
            return app;
        }
    }
}
