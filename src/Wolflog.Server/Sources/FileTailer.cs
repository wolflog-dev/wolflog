using System.Text.RegularExpressions;

namespace Wolflog.Server.Sources;

/// <summary>
/// Suit un ou plusieurs fichiers (motif avec *) comme « tail -F » : nouveaux fichiers, rotation, troncature,
/// lignes de continuation (piles d'appels) rattachées à l'entrée précédente.
/// </summary>
public sealed partial class FileTailer(LogSource source, FilePositions positions, EntrySink sink, SourceStatus status)
{
    private sealed class Tracked
    {
        public long Position;
        public string Pending = "";
        public LineParsers.W3C W3C = new();
    }

    private readonly Dictionary<string, Tracked> _files = new(StringComparer.OrdinalIgnoreCase);
    private bool _firstScan = true;

    [GeneratedRegex(@"^[\w.]*(?:Exception|Error)$")]
    private static partial Regex ExceptionHeader();

    public async Task RunAsync(CancellationToken ct)
    {
        status.State = "running";
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var files = Resolve(source.Path ?? "");
                status.Files = files.Count;
                status.Detail = files.Count == 0 ? "Aucun fichier ne correspond pour l'instant" : $"{files.Count} fichier(s) suivi(s)";
                foreach (var file in files) await ReadAsync(file, ct);
                foreach (var gone in _files.Keys.Except(files, StringComparer.OrdinalIgnoreCase).ToList()) _files.Remove(gone);
                _firstScan = false;
                positions.Save();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                status.LastError = ex.Message;
                status.LastErrorAt = DateTime.UtcNow;
            }
            await Task.Delay(1000, ct);
        }
    }

    /// <summary>Fichiers correspondant au motif (« * » et « ? » dans le nom ; « ** » pour les sous-dossiers).</summary>
    public static List<string> Resolve(string pattern)
    {
        pattern = Environment.ExpandEnvironmentVariables(pattern.Trim());
        if (pattern.Length == 0) return [];
        if (!pattern.Contains('*') && !pattern.Contains('?')) return File.Exists(pattern) ? [Path.GetFullPath(pattern)] : [];
        var recursive = pattern.Contains("**");
        var dir = Path.GetDirectoryName(pattern.Replace("**" + Path.DirectorySeparatorChar, "").Replace("**/", "")) ?? ".";
        var name = Path.GetFileName(pattern);
        if (!Directory.Exists(dir)) return [];
        return Directory.EnumerateFiles(dir, name, recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly)
            .Select(Path.GetFullPath).Order().ToList();
    }

    private async Task ReadAsync(string file, CancellationToken ct)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (!_files.TryGetValue(file, out var t))
        {
            t = new Tracked();
            PrimeW3C(stream, t.W3C);
            if (positions.TryGet(file, out var saved) && saved <= stream.Length) t.Position = saved;
            else t.Position = _firstScan && source.StartAtEnd ? stream.Length : 0; // fichier apparu après le démarrage : lu en entier
            _files[file] = t;
        }
        if (stream.Length < t.Position)
        {
            // Fichier tronqué ou remplacé (rotation) : reprise au début.
            t.Position = 0;
            t.Pending = "";
        }
        if (stream.Length == t.Position) return;

        stream.Position = t.Position;
        var buffer = new byte[Math.Min(4 * 1024 * 1024, stream.Length - t.Position)];
        var read = await stream.ReadAsync(buffer, ct);
        t.Position += read;
        var text = t.Pending + LineParsers.Decode(buffer, read);
        var lastNewLine = text.LastIndexOf('\n');
        if (lastNewLine < 0)
        {
            t.Pending = text;
            positions.Set(file, t.Position - Encoding.UTF8.GetByteCount(t.Pending));
            return;
        }
        t.Pending = text[(lastNewLine + 1)..];

        var entries = new List<ParsedEntry>();
        ParsedEntry? current = null;
        foreach (var raw in text[..lastNewLine].Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            if (current != null && LineParsers.IsContinuation(line))
            {
                current.Body += "\n" + line;
                continue;
            }
            if (current != null) entries.Add(Finish(current));
            current = Parse(line, t);
        }
        if (current != null) entries.Add(Finish(current));
        positions.Set(file, t.Position - Encoding.UTF8.GetByteCount(t.Pending));

        if (entries.Count == 0) return;
        foreach (var e in entries)
        {
            e.Attributes.TryAdd("log.file.name", Path.GetFileName(file));
        }
        await sink(entries, ct);
        status.Entries += entries.Count;
        status.LastEntryAt = DateTime.UtcNow;
    }

    /// <summary>Journal W3C (IIS) : l'ordre des colonnes est décrit en tête de fichier, lue même si la lecture reprend plus loin.</summary>
    private static void PrimeW3C(FileStream stream, LineParsers.W3C w3c)
    {
        var head = new byte[Math.Min(4096, stream.Length)];
        stream.ReadExactly(head);
        stream.Position = 0;
        foreach (var line in Encoding.UTF8.GetString(head).Split('\n'))
        {
            if (!line.StartsWith('#')) break;
            w3c.Parse(line.TrimEnd('\r'));
        }
    }

    private ParsedEntry? Parse(string line, Tracked t) => LineParsers.ParseLine(source.Format, line, t.W3C);

    /// <summary>Une pile d'appels (continuation ou champ dédié) fait de l'entrée une exception, regroupée dans Erreurs.</summary>
    public static ParsedEntry Finish(ParsedEntry e)
    {
        if (e.Attributes.ContainsKey("exception.type")) return e;
        var stack = e.Attributes.GetValueOrDefault("exception.stacktrace");
        if (stack is null && e.Body.Split('\n').Skip(1).Any(LineParsers.IsContinuation)) stack = e.Body;
        if (stack is null) return e;
        foreach (var line in stack.Split('\n').Take(3))
        {
            var words = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var header = words.FirstOrDefault(w => ExceptionHeader().IsMatch(w.TrimEnd(':')));
            if (header is null) continue;
            var type = header.TrimEnd(':');
            e.Attributes["exception.type"] = type;
            e.Attributes["exception.message"] = line[(line.IndexOf(header, StringComparison.Ordinal) + header.Length)..].Trim().TrimStart(':').Trim();
            e.Attributes["exception.stacktrace"] = stack[stack.IndexOf(type, StringComparison.Ordinal)..];
            if (e.Severity < 17) e.Severity = 17;
            break;
        }
        return e;
    }
}
