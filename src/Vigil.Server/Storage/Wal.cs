using System.Buffers.Binary;

namespace Vigil.Server.Storage;

/// <summary>
/// Journal d'écriture (write-ahead log) : chaque lot reçu y est écrit avant d'être acquitté.
/// Un fichier par génération ; une génération est supprimée dès que ses données sont en Parquet.
/// Format : [int32 longueur][int32 crc][payload protobuf]...
/// </summary>
public sealed class Wal : IDisposable
{
    private readonly string _dir;
    private readonly bool _fsync;
    private FileStream? _stream;

    public long Generation { get; private set; }

    public Wal(string dir, bool fsync)
    {
        _dir = dir;
        _fsync = fsync;
        Directory.CreateDirectory(dir);
    }

    public IReadOnlyList<string> ExistingFiles() =>
        Directory.GetFiles(_dir, "wal-*.log").Order(StringComparer.Ordinal).ToList();

    public void Open(long generation)
    {
        _stream?.Dispose();
        Generation = generation;
        _stream = new FileStream(PathFor(generation), FileMode.Append, FileAccess.Write, FileShare.Read, 1 << 16);
    }

    public string PathFor(long generation) => Path.Combine(_dir, $"wal-{generation:D12}.log");

    public void Append(ReadOnlySpan<byte> payload)
    {
        Span<byte> header = stackalloc byte[8];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(header[4..], Crc32(payload));
        _stream!.Write(header);
        _stream.Write(payload);
    }

    /// <summary>Pousse les données vers l'OS (survit à un crash du processus) ; fsync optionnel.</summary>
    public void Commit() => _stream!.Flush(_fsync);

    public void Delete(long generation)
    {
        try { File.Delete(PathFor(generation)); } catch (IOException) { }
    }

    /// <summary>Relit un fichier WAL ; s'arrête proprement sur un enregistrement tronqué ou corrompu.</summary>
    public static IEnumerable<byte[]> Read(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var header = new byte[8];
        while (true)
        {
            if (fs.ReadAtLeast(header, 8, throwOnEndOfStream: false) < 8) yield break;
            var len = BinaryPrimitives.ReadInt32LittleEndian(header);
            var crc = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4));
            if (len < 0 || len > 256 * 1024 * 1024) yield break;
            var payload = new byte[len];
            if (fs.ReadAtLeast(payload, len, throwOnEndOfStream: false) < len) yield break;
            if (Crc32(payload) != crc) yield break;
            yield return payload;
        }
    }

    public static long GenerationOf(string path) =>
        long.Parse(Path.GetFileNameWithoutExtension(path).AsSpan(4), System.Globalization.CultureInfo.InvariantCulture);

    private static uint Crc32(ReadOnlySpan<byte> data) => System.IO.Hashing.Crc32.HashToUInt32(data);

    public void Dispose() => _stream?.Dispose();
}
