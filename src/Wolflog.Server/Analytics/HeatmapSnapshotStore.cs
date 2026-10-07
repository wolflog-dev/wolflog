using System.IO.Compression;
using System.Security.Cryptography;

namespace Wolflog.Server.Analytics;

/// <summary>
/// Captures de pages des cartes de chaleur (voir <see cref="HeatmapSnapshot"/>) : la carte s'affiche sur la capture quand la page
/// en direct n'est pas affichable dans Wolflog (site en HTTP et Wolflog en HTTPS, connexion demandée, site injoignable).
/// La plus récente par service, page et appareil, compressée dans &lt;data&gt;/snapshots ; 90 jours au plus, nombre limité par
/// service et nombre de services limité (la clé du script navigateur est publique).
/// </summary>
public sealed class HeatmapSnapshotStore(StorageHost storage)
{
    /// <summary>Âge au-delà duquel une capture est redemandée aux navigateurs.</summary>
    public static readonly TimeSpan Freshness = TimeSpan.FromHours(24);
    public const int MaxHtmlLength = 2_000_000;
    private const int MaxPerService = 500;
    private const int MaxServices = 200;
    private static readonly TimeSpan Retention = TimeSpan.FromDays(90);
    private static readonly string[] Devices = ["desktop", "tablet", "mobile"];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly Lock _gate = new();

    private string Root => Path.Combine(storage.DataDirectory, "snapshots");

    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..24];

    private string ServiceDirectory(string service) => Path.Combine(Root, Hash(service));

    private static string FileName(string path, string device) => Hash(path + "\n" + device) + ".json.gz";

    /// <summary>Faut-il une capture de cette page pour cet appareil (aucune, ou plus vieille qu'un jour) ?</summary>
    public bool Wanted(string service, string path, string device)
    {
        var file = Path.Combine(ServiceDirectory(service), FileName(path, device));
        return !File.Exists(file) || DateTime.UtcNow - File.GetLastWriteTimeUtc(file) > Freshness;
    }

    /// <summary>Enregistre la capture, qui remplace la précédente ; false si le nombre de services est atteint.</summary>
    public bool Save(HeatmapSnapshot snapshot)
    {
        lock (_gate)
        {
            var directory = ServiceDirectory(snapshot.Service);
            if (!Directory.Exists(directory))
            {
                if (Directory.Exists(Root) && Directory.EnumerateDirectories(Root).Count() >= MaxServices) return false;
                Directory.CreateDirectory(directory);
            }
            var file = Path.Combine(directory, FileName(snapshot.Path, snapshot.Device));
            var tmp = file + ".tmp";
            using (var stream = File.Create(tmp))
            using (var gzip = new GZipStream(stream, CompressionLevel.Optimal))
                JsonSerializer.Serialize(gzip, snapshot, Json);
            File.Move(tmp, file, overwrite: true);
            Prune(directory);
            return true;
        }
    }

    /// <summary>
    /// Capture la plus récente d'une page, parmi les services visibles : pour cet appareil, sinon pour un autre (la page,
    /// réaffichée à la largeur de la carte, s'adapte comme dans le navigateur).
    /// </summary>
    public HeatmapSnapshot? Find(string? service, string path, string? device, ServiceScope scope)
    {
        if (!Directory.Exists(Root)) return null;
        var directories = service is null ? Directory.GetDirectories(Root) : [ServiceDirectory(service)];
        var devices = string.IsNullOrEmpty(device) ? Devices : [device, .. Devices.Where(d => d != device)];
        foreach (var d in devices)
        {
            HeatmapSnapshot? best = null;
            foreach (var directory in directories)
            {
                var file = Path.Combine(directory, FileName(path, d));
                if (!File.Exists(file) || Read(file) is not { } found || !scope.Allows(found.Service)) continue;
                if (service is not null && found.Service != service) continue;
                if (best is null || found.CapturedAt > best.CapturedAt) best = found;
            }
            if (best is not null) return best;
        }
        return null;
    }

    private static HeatmapSnapshot? Read(string file)
    {
        try
        {
            using var stream = File.OpenRead(file);
            using var gzip = new GZipStream(stream, CompressionMode.Decompress);
            return JsonSerializer.Deserialize<HeatmapSnapshot>(gzip, Json);
        }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidDataException)
        {
            return null;
        }
    }

    /// <summary>Captures de plus de 90 jours, et les plus anciennes au-delà de la limite du service.</summary>
    private static void Prune(string directory)
    {
        var limit = DateTime.UtcNow - Retention;
        var files = new DirectoryInfo(directory).GetFiles("*.json.gz").OrderByDescending(f => f.LastWriteTimeUtc).ToList();
        for (var i = 0; i < files.Count; i++)
        {
            if (i < MaxPerService && files[i].LastWriteTimeUtc >= limit) continue;
            try { files[i].Delete(); } catch (IOException) { /* lu en ce moment : supprimé la prochaine fois */ }
        }
    }
}
