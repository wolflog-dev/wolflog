using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text.Json;
using Google.Protobuf;

namespace Vigil.Server.Sources;

/// <summary>
/// Mode agent : le même binaire, installé sur un serveur applicatif, lit des fichiers de logs (IIS, texte, JSON, Docker…)
/// ou écoute syslog, et les envoie à un serveur Vigil distant en OTLP.
/// </summary>
public static class Agent
{
    public sealed class AgentConfig
    {
        public string Endpoint { get; set; } = "";
        public string ApiKey { get; set; } = "";
        public List<LogSource> Sources { get; set; } = [];
    }

    public const string Help = """
        Mode agent : lit des fichiers de logs sur cette machine et les envoie à un serveur Vigil.

          vigil agent --endpoint https://vigil:5080 --key <clé> --file "C:\inetpub\logs\LogFiles\W3SVC1\*.log" --format iis --service mon-site
          vigil agent --config agent.json

        Options (une source) :
          --file <motif>        Fichiers à suivre (* autorisé)          --format auto|plain|json|iis|docker|cri
          --syslog <port>       Écoute syslog UDP/TCP au lieu de fichiers
          --service <nom>       Nom du service                           --env <environnement>
          --from-start          Lire aussi le contenu déjà présent

        agent.json : { "Endpoint": "…", "ApiKey": "…", "Sources": [ { "Name": "iis", "Type": "file", "Path": "…", "Format": "iis" } ] }
        """;

    public static int Run(string[] args)
    {
        var o = ParseArgs(args);
        AgentConfig config;
        if (o.TryGetValue("config", out var path))
        {
            config = JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
        }
        else
        {
            config = new AgentConfig { Endpoint = o.GetValueOrDefault("endpoint", ""), ApiKey = o.GetValueOrDefault("key", "") };
            var syslog = o.TryGetValue("syslog", out var port);
            if (syslog || o.ContainsKey("file"))
                config.Sources.Add(new LogSource
                {
                    Id = "agent", Name = o.GetValueOrDefault("service", syslog ? "syslog" : Path.GetFileNameWithoutExtension(o["file"].Replace("*", ""))),
                    Type = syslog ? "syslog" : "file", Path = o.GetValueOrDefault("file"), Format = o.GetValueOrDefault("format", "auto"),
                    Port = syslog && int.TryParse(port, out var p) ? p : 5514, Service = o.GetValueOrDefault("service"), Env = o.GetValueOrDefault("env"),
                    StartAtEnd = !o.ContainsKey("from-start"),
                });
        }
        if (string.IsNullOrWhiteSpace(config.Endpoint) || config.Sources.Count == 0)
        {
            Console.WriteLine(Help);
            return 1;
        }

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => cts.Cancel();
        using var http = new HttpClient { BaseAddress = new Uri(config.Endpoint.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(30) };
        if (!string.IsNullOrEmpty(config.ApiKey)) http.DefaultRequestHeaders.Add("x-vigil-key", config.ApiKey);
        var positions = new FilePositions(Path.Combine(AppContext.BaseDirectory, "vigil-agent-positions.json"));

        var tasks = new List<Task>();
        foreach (var source in config.Sources.Where(s => s.Enabled))
        {
            if (string.IsNullOrEmpty(source.Name)) source.Name = source.Service ?? "agent";
            var status = new SourceStatus();
            var sink = new BatchingSink(source, (logs, spans, ct) => SendAsync(http, logs, spans, ct), status);
            tasks.Add(sink.RunAsync(cts.Token));
            tasks.Add(source.Type == "syslog"
                ? new SyslogListener(source, sink.Add, status).RunAsync(cts.Token)
                : new FileTailer(source, positions, sink.Add, status).RunAsync(cts.Token));
            Console.WriteLine($"Source « {source.Name} » : {(source.Type == "syslog" ? "syslog, port " + source.Port : source.Path + " (" + source.Format + ")")} → {config.Endpoint}");
            _ = Task.Run(async () =>
            {
                string? lastError = null;
                while (!cts.IsCancellationRequested)
                {
                    await Task.Delay(5000, cts.Token).ContinueWith(_ => { });
                    if (status.LastError != null && status.LastError != lastError) Console.Error.WriteLine($"{source.Name} : {status.LastError}");
                    lastError = status.LastError;
                }
            });
        }
        try { Task.WaitAll([.. tasks], cts.Token); }
        catch (OperationCanceledException) { }
        catch (AggregateException ex) when (ex.InnerExceptions.All(e => e is OperationCanceledException)) { }
        positions.Save();
        return 0;
    }

    /// <summary>Envoi OTLP/HTTP compressé, avec quelques nouvelles tentatives si le serveur est momentanément injoignable.</summary>
    private static async Task SendAsync(HttpClient http, IMessage? logs, IMessage? spans, CancellationToken ct)
    {
        if (logs != null) await PostAsync(http, "v1/logs", logs, ct);
        if (spans != null) await PostAsync(http, "v1/traces", spans, ct);
    }

    private static async Task PostAsync(HttpClient http, string path, IMessage message, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true)) message.WriteTo(gzip);
        var body = buffer.ToArray();
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var content = new ByteArrayContent(body);
                content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
                content.Headers.ContentEncoding.Add("gzip");
                using var response = await http.PostAsync(path, content, ct);
                if (response.IsSuccessStatusCode) return;
                if ((int)response.StatusCode is 400 or 401 or 403 or 413)
                    throw new HttpRequestException($"Refusé par le serveur ({(int)response.StatusCode}) : clé API ou message invalide.");
                throw new HttpRequestException($"Réponse {(int)response.StatusCode}");
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested && attempt < 6
                                       && !ex.Message.StartsWith("Refusé"))
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, 2 * attempt)), ct);
            }
        }
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var o = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--")) continue;
            var key = args[i][2..];
            o[key] = i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[++i] : "true";
        }
        return o;
    }
}
