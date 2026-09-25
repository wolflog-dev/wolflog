using System.Text;
using Vigil.Server.Sources;

namespace Vigil.Server.Api;

/// <summary>Sources lues par Vigil : fichiers de logs (texte, JSON, IIS, Docker, Kubernetes) et syslog.</summary>
public static class SourceEndpoints
{
    public sealed record PreviewInput(string? Type, string? Path, string? Format);

    extension(WebApplication app)
    {
        public void MapVigilSources(RouteGroupBuilder admin)
        {
            admin.MapGet("/sources", (LogSourceStore store, SourceHost host) =>
                Results.Ok(store.All().OrderBy(s => s.Name, StringComparer.CurrentCultureIgnoreCase).Select(s => new
                {
                    source = s,
                    status = s.Enabled ? host.Status(s.Id) ?? new SourceStatus() : new SourceStatus { State = "paused" },
                })));

            admin.MapPost("/sources", (LogSource body, LogSourceStore store) =>
            {
                body.Id = "";
                body.CreatedAt = DateTime.UtcNow;
                return Validate(body, store) is { } error ? Results.BadRequest(new { error }) : Results.Ok(store.Upsert(body));
            });

            admin.MapPut("/sources/{id}", (string id, LogSource body, LogSourceStore store) =>
            {
                var existing = store.Get(id);
                if (existing is null) return Results.NotFound();
                body.Id = id;
                body.CreatedAt = existing.CreatedAt;
                return Validate(body, store) is { } error ? Results.BadRequest(new { error }) : Results.Ok(store.Upsert(body));
            });

            admin.MapDelete("/sources/{id}", (string id, LogSourceStore store) => store.Delete(id) ? Results.Ok() : Results.NotFound());

            // Aperçu : fichiers trouvés et dernières lignes telles qu'elles seront interprétées.
            admin.MapPost("/sources/preview", (PreviewInput body) =>
            {
                if (body.Type == "syslog") return Results.Ok(new { files = Array.Empty<string>(), entries = Array.Empty<object>() });
                List<string> files;
                try { files = FileTailer.Resolve(body.Path ?? ""); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
                {
                    return Results.BadRequest(new { error = ex.Message });
                }
                var entries = new List<object>();
                var newest = files.OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
                if (newest != null)
                {
                    var source = new LogSource { Path = newest, Format = body.Format ?? "auto", StartAtEnd = false };
                    foreach (var e in Tail(newest, source).TakeLast(8))
                        entries.Add(new
                        {
                            e.Ts, level = e.Severity >= 21 ? "fatal" : e.Severity >= 17 ? "error" : e.Severity >= 13 ? "warn" : e.Severity >= 9 ? "info" : "debug",
                            e.Body, e.Service, http = e.Http, exception = e.Attributes.GetValueOrDefault("exception.type"),
                        });
                }
                return Results.Ok(new { files = files.Take(20), total = files.Count, newest, entries });
            });
        }
    }

    /// <summary>Dernières entrées d'un fichier (lecture des 64 derniers Ko, en-têtes W3C compris).</summary>
    private static List<ParsedEntry> Tail(string file, LogSource source)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var start = Math.Max(0, stream.Length - 64 * 1024);
        var header = "";
        if (start > 0 && source.Format is "iis" or "auto")
        {
            // Les colonnes W3C sont décrites en tête de fichier.
            var head = new byte[Math.Min(4096, stream.Length)];
            stream.ReadExactly(head);
            header = string.Join("\n", Encoding.UTF8.GetString(head).Split('\n').Where(l => l.StartsWith("#Fields:"))) + "\n";
        }
        stream.Position = start;
        var bytes = new byte[stream.Length - start];
        stream.ReadExactly(bytes);
        var text = header + Encoding.UTF8.GetString(bytes);
        var lines = text.Split('\n').Select(l => l.TrimEnd('\r')).ToList();
        if (start > 0 && header.Length == 0) lines.RemoveAt(0); // ligne probablement coupée
        var w3c = new LineParsers.W3C();
        var result = new List<ParsedEntry>();
        foreach (var line in lines.Where(l => l.Length > 0))
        {
            var e = LineParsers.ParseLine(source.Format, line, w3c);
            if (e is null) continue;
            if (result.Count > 0 && e.Http is null && LineParsers.IsContinuation(line))
            {
                result[^1].Body += "\n" + line;
                continue;
            }
            result.Add(e);
        }
        return result.Select(FileTailer.Finish).ToList();
    }

    private static string? Validate(LogSource s, LogSourceStore store)
    {
        if (string.IsNullOrWhiteSpace(s.Name)) return "Donnez un nom à la source.";
        if (s.Type == "syslog")
        {
            if (s.Port is < 1 or > 65535) return "Port invalide.";
            if (store.All().Any(x => x.Id != s.Id && x.Type == "syslog" && x.Port == s.Port)) return $"Le port {s.Port} est déjà utilisé par une autre source.";
            return null;
        }
        if (string.IsNullOrWhiteSpace(s.Path)) return "Indiquez le chemin des fichiers (ex. /var/log/app/*.log).";
        if (!LineParsers.Formats.Contains(s.Format)) return "Format inconnu.";
        return null;
    }
}
