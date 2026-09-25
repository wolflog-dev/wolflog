namespace Wolflog.Client.Internal;

/// <summary>Tampon disque : un fichier gzip par lot, renvoyé dans l'ordre. Partageable entre processus.</summary>
internal sealed class DiskOutbox
{
    private readonly string _dir;
    private readonly long _maxBytes;
    private long _seq;
    private int _pendingHint = -1;

    public readonly record struct Entry(string Path, string Signal);

    public DiskOutbox(string directory, long maxBytes)
    {
        _dir = System.IO.Path.Combine(directory, "outbox");
        _maxBytes = maxBytes;
        Directory.CreateDirectory(_dir);
    }

    public bool HasPending
    {
        get
        {
            if (_pendingHint == 0) return false;
            var any = Directory.EnumerateFiles(_dir, "*.gz").Any();
            _pendingHint = any ? 1 : 0;
            return any;
        }
    }

    public void Store(string signal, byte[] gzipped)
    {
        var name = $"{DateTime.UtcNow.Ticks:D19}-{Environment.ProcessId}-{Interlocked.Increment(ref _seq):D6}.{signal}.gz";
        var path = System.IO.Path.Combine(_dir, name);
        var tmp = path + ".tmp";
        try
        {
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                fs.Write(gzipped);
            }
            File.Move(tmp, path);
            _pendingHint = 1;
            EnforceLimit();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Trace.TraceWarning($"Wolflog : impossible d'écrire dans le tampon {_dir} : {ex.Message}");
        }
    }

    public IEnumerable<Entry> Pending()
    {
        foreach (var file in Directory.GetFiles(_dir, "*.gz").Order(StringComparer.Ordinal))
        {
            var name = System.IO.Path.GetFileName(file);
            var parts = name.Split('.');
            if (parts.Length >= 3) yield return new Entry(file, parts[^2]);
        }
        _pendingHint = -1;
    }

    /// <summary>Verrou exclusif sur un fichier (évite qu'un autre processus l'envoie en double).</summary>
    public Claim? TryClaim(Entry entry)
    {
        try
        {
            return new Claim(new FileStream(entry.Path, FileMode.Open, FileAccess.ReadWrite, FileShare.None));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public sealed class Claim(FileStream stream) : IDisposable
    {
        private bool _complete;

        public byte[] Read()
        {
            var data = new byte[stream.Length];
            stream.Position = 0;
            stream.ReadExactly(data);
            return data;
        }

        public void Complete() => _complete = true;

        public void Dispose()
        {
            var path = stream.Name;
            stream.Dispose();
            if (_complete)
            {
                try { File.Delete(path); } catch (IOException) { }
            }
        }
    }

    private void EnforceLimit()
    {
        var files = new DirectoryInfo(_dir).GetFiles("*.gz");
        var total = files.Sum(f => f.Length);
        if (total <= _maxBytes) return;
        foreach (var f in files.OrderBy(f => f.Name, StringComparer.Ordinal))
        {
            if (total <= _maxBytes) break;
            try
            {
                total -= f.Length;
                f.Delete();
            }
            catch (IOException) { }
        }
    }
}
