using Microsoft.Extensions.Options;

namespace Wolflog.Server.Hosting;

/// <summary>
/// Empêche deux instances d'écrire dans le même dossier de données
/// (ex. recyclage IIS avec chevauchement). Attend jusqu'à 60 s que l'ancienne instance libère le verrou.
/// </summary>
public sealed class DataDirectoryLock : IHostedService, IDisposable
{
    private readonly string _path;
    private readonly ILogger<DataDirectoryLock> _log;
    private FileStream? _lock;

    public DataDirectoryLock(IOptions<WolflogServerOptions> options, IHostEnvironment env, ILogger<DataDirectoryLock> log)
    {
        var dir = options.Value.ResolveDataDirectory(env.ContentRootPath);
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, ".lock");
        _log = log;
        Acquire();
    }

    private void Acquire()
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var warned = false;
        while (true)
        {
            try
            {
                _lock = new FileStream(_path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
                return;
            }
            catch (IOException) when (DateTime.UtcNow < deadline)
            {
                if (!warned)
                {
                    _log.LogWarning("Le dossier de données est utilisé par une autre instance de Wolflog, attente…");
                    warned = true;
                }
                Thread.Sleep(500);
            }
            catch (IOException ex)
            {
                throw new InvalidOperationException(
                    $"Le dossier de données est déjà utilisé par une autre instance de Wolflog ({_path}). " +
                    "Sous IIS, désactivez le recyclage avec chevauchement (disallowOverlappingRotation).", ex);
            }
        }
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public void Dispose() => _lock?.Dispose();
}
