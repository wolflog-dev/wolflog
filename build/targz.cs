// Crée une archive .tar.gz en conservant les droits d'exécution Unix (impossible avec tar sous Windows).
// Usage : dotnet run build/targz.cs -- <dossier> <archive.tar.gz>
using System.Formats.Tar;
using System.IO.Compression;

var source = Path.GetFullPath(args[0]);
var archive = Path.GetFullPath(args[1]);
var root = Path.GetFileName(source.TrimEnd(Path.DirectorySeparatorChar));

await using var file = File.Create(archive);
await using var gzip = new GZipStream(file, CompressionLevel.Optimal);
await using var tar = new TarWriter(gzip, TarEntryFormat.Pax);

foreach (var path in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
{
    var relative = Path.GetRelativePath(source, path).Replace('\\', '/');
    var name = Path.GetFileName(path);
    var executable = name == "wolflog" || name.EndsWith(".sh", StringComparison.Ordinal);
    var entry = new PaxTarEntry(TarEntryType.RegularFile, $"{root}/{relative}")
    {
        Mode = executable
            ? UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute
            : UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead,
        ModificationTime = File.GetLastWriteTimeUtc(path),
    };
    await using var data = File.OpenRead(path);
    entry.DataStream = data;
    await tar.WriteEntryAsync(entry);
}
Console.WriteLine(archive);
