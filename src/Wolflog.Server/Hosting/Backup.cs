using System.IO.Compression;
using System.Text.RegularExpressions;

namespace Wolflog.Server.Hosting;

/// <summary>
/// Sauvegarde et restauration du dossier de données.
/// Configuration : fichiers JSON (comptes, clés, tableaux, alertes, sondes…). Données : segments Parquet déjà écrits.
/// </summary>
public static partial class Backup
{
    /// <summary>Dossiers des signaux (segments Parquet et index).</summary>
    public static readonly string[] SignalDirectories = ["logs", "spans", "metrics"];

    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]*\.json$")]
    private static partial Regex ConfigFileName();

    public static bool IsConfigFile(string name) => ConfigFileName().IsMatch(name) && !name.EndsWith(".tmp", StringComparison.Ordinal);

    public static IEnumerable<string> ConfigFiles(string dataDirectory) =>
        Directory.Exists(dataDirectory)
            ? Directory.EnumerateFiles(dataDirectory, "*.json").Where(f => IsConfigFile(Path.GetFileName(f))).Order()
            : [];

    /// <summary>Écrit l'archive dans <paramref name="output"/> (flux en écriture seule accepté).</summary>
    public static void Write(string dataDirectory, Stream output, bool includeData)
    {
        using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
        foreach (var file in ConfigFiles(dataDirectory))
            Add(zip, file, "config/" + Path.GetFileName(file), CompressionLevel.Optimal);

        if (includeData)
        {
            foreach (var signal in SignalDirectories)
            {
                var dir = Path.Combine(dataDirectory, signal);
                if (!Directory.Exists(dir)) continue;
                foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                {
                    var name = Path.GetFileName(file);
                    if (!(name.EndsWith(".parquet", StringComparison.Ordinal) || name.EndsWith(".idx", StringComparison.Ordinal))) continue;
                    var relative = Path.GetRelativePath(dataDirectory, file).Replace('\\', '/');
                    // Parquet est déjà compressé (zstd) : stockage sans recompression.
                    Add(zip, file, "data/" + relative, CompressionLevel.NoCompression);
                }
            }
        }

        var readme = zip.CreateEntry("LISEZMOI.txt");
        using var w = new StreamWriter(readme.Open());
        w.WriteLine($"Sauvegarde Wolflog du {DateTime.Now:dd/MM/yyyy HH:mm}.");
        w.WriteLine(includeData ? "Contient la configuration et les données." : "Contient la configuration seulement.");
        w.WriteLine("Restauration : arrêter Wolflog, puis 'wolflog restore <fichier.zip>' (ou Administration > Système pour la configuration seule).");
    }

    private static void Add(ZipArchive zip, string file, string entryName, CompressionLevel level)
    {
        FileStream source;
        try { source = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); }
        catch (FileNotFoundException) { return; } // segment supprimé entre-temps (compaction, rétention)
        using (source)
        {
            var entry = zip.CreateEntry(entryName, level);
            entry.LastWriteTime = File.GetLastWriteTime(file);
            using var target = entry.Open();
            source.CopyTo(target);
        }
    }

    public sealed record RestoreResult(int ConfigFiles, int DataFiles);

    /// <summary>
    /// Restaure une archive. <paramref name="includeData"/> = false : fichiers de configuration seulement
    /// (possible pendant que le serveur tourne : ils sont relus automatiquement).
    /// </summary>
    public static RestoreResult Restore(string dataDirectory, Stream archive, bool includeData)
    {
        using var zip = new ZipArchive(archive, ZipArchiveMode.Read);
        var root = Path.GetFullPath(dataDirectory);
        Directory.CreateDirectory(root);
        int config = 0, data = 0;
        foreach (var entry in zip.Entries)
        {
            if (entry.FullName.StartsWith("config/", StringComparison.Ordinal))
            {
                var name = entry.FullName["config/".Length..];
                if (!IsConfigFile(name)) continue;
                var target = Path.Combine(root, name);
                var tmp = target + ".tmp";
                entry.ExtractToFile(tmp, overwrite: true);
                File.Move(tmp, target, overwrite: true);
                config++;
            }
            else if (includeData && entry.FullName.StartsWith("data/", StringComparison.Ordinal))
            {
                var relative = entry.FullName["data/".Length..];
                var target = Path.GetFullPath(Path.Combine(root, relative));
                // Protection contre les chemins sortant du dossier de données.
                if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) continue;
                if (!SignalDirectories.Contains(relative.Split('/')[0])) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                entry.ExtractToFile(target, overwrite: true);
                data++;
            }
        }
        return new RestoreResult(config, data);
    }
}
