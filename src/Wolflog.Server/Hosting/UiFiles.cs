using Microsoft.Extensions.FileProviders;

namespace Wolflog.Server.Hosting;

/// <summary>Fichiers de l'interface : dossier wwwroot à côté du binaire s'il existe (développement), sinon ceux embarqués.</summary>
internal static class UiFiles
{
    public static IFileProvider? Create(ILogger log)
    {
        var physical = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (File.Exists(Path.Combine(physical, "index.html"))) return new PhysicalFileProvider(physical);
        try
        {
            var embedded = new ManifestEmbeddedFileProvider(typeof(Program).Assembly, "wwwroot");
            if (embedded.GetFileInfo("index.html").Exists) return embedded;
        }
        catch (InvalidOperationException) { }
        log.LogWarning("Interface web absente : lancez 'npm run build' dans ui/ puis recompilez.");
        return null;
    }
}
