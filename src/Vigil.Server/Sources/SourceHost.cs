using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Options;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;
using Vigil.Server.Ingestion;

namespace Vigil.Server.Sources;

/// <summary>Regroupe les entrées par lots (au plus 500 ms ou 1 000 entrées) avant conversion et envoi.</summary>
public sealed class BatchingSink(LogSource source, Func<ExportLogsServiceRequest?, ExportTraceServiceRequest?, CancellationToken, Task> send, SourceStatus status)
{
    private readonly Channel<ParsedEntry> _channel = Channel.CreateBounded<ParsedEntry>(new BoundedChannelOptions(50_000)
    {
        SingleReader = true, FullMode = BoundedChannelFullMode.Wait,
    });

    public async Task Add(IReadOnlyList<ParsedEntry> entries, CancellationToken ct)
    {
        foreach (var e in entries) await _channel.Writer.WriteAsync(e, ct);
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var batch = new List<ParsedEntry>(1000);
        var reader = _channel.Reader;
        while (await reader.WaitToReadAsync(ct))
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(500);
            while (batch.Count < 1000)
            {
                while (batch.Count < 1000 && reader.TryRead(out var e)) batch.Add(e);
                if (batch.Count >= 1000 || DateTime.UtcNow >= deadline) break;
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
                wait.CancelAfter(deadline - DateTime.UtcNow);
                try { if (!await reader.WaitToReadAsync(wait.Token)) break; }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { break; }
            }
            if (batch.Count == 0) continue;
            var service = string.IsNullOrWhiteSpace(source.Service) ? source.Name : source.Service;
            var (logs, spans) = OtlpBuilder.Build(batch, service, string.IsNullOrWhiteSpace(source.Env) ? null : source.Env, source.Name);
            try
            {
                await send(logs, spans, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                status.LastError = "Envoi impossible : " + ex.Message;
                status.LastErrorAt = DateTime.UtcNow;
            }
            batch.Clear();
        }
    }
}

/// <summary>Démarre, arrête et redémarre les sources selon la configuration (sources.json), sans redémarrer Vigil.</summary>
public sealed class SourceHost(LogSourceStore store, Ingestor ingestor, IOptions<VigilServerOptions> options, IHostEnvironment env, ILogger<SourceHost> log)
    : BackgroundService
{
    private sealed record Worker(string Signature, CancellationTokenSource Cts, Task Task, SourceStatus Status);

    private readonly ConcurrentDictionary<string, Worker> _workers = new();
    private FilePositions? _positions;

    public SourceStatus? Status(string id) => _workers.TryGetValue(id, out var w) ? w.Status : null;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        _positions = new FilePositions(Path.Combine(options.Value.ResolveDataDirectory(env.ContentRootPath), "sources-positions.json"));
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        do
        {
            try { Reconcile(stop); }
            catch (Exception ex) when (!stop.IsCancellationRequested) { log.LogWarning(ex, "Sources"); }
        }
        while (await timer.WaitForNextTickAsync(stop));
        foreach (var w in _workers.Values) w.Cts.Cancel();
        _positions.Save();
    }

    private void Reconcile(CancellationToken stop)
    {
        var wanted = store.All().Where(s => s.Enabled).ToDictionary(s => s.Id);
        foreach (var (id, w) in _workers)
        {
            if (wanted.TryGetValue(id, out var s) && Signature(s) == w.Signature && !w.Task.IsCompleted) continue;
            if (w.Task.IsCompleted && wanted.ContainsKey(id) && Signature(wanted[id]) == w.Signature && DateTime.UtcNow - (w.Status.LastErrorAt ?? DateTime.MinValue) < TimeSpan.FromSeconds(30))
                continue; // échec récent (port occupé…) : nouvel essai dans 30 s
            w.Cts.Cancel();
            _workers.TryRemove(id, out _);
        }
        foreach (var (id, s) in wanted)
        {
            if (_workers.ContainsKey(id)) continue;
            _workers[id] = Start(s, stop);
        }
    }

    private static string Signature(LogSource s) => JsonSerializer.Serialize(s);

    private Worker Start(LogSource s, CancellationToken stop)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(stop);
        var status = new SourceStatus();
        var sink = new BatchingSink(s, async (logs, spans, ct) =>
        {
            if (logs != null) await ingestor.IngestLogs(logs, default, ct);
            if (spans != null) await ingestor.IngestSpans(spans, default, ct);
        }, status);
        var task = Task.Run(async () =>
        {
            try
            {
                _ = sink.RunAsync(cts.Token);
                try
                {
                    await (s.Type == "syslog"
                        ? new SyslogListener(s, sink.Add, status).RunAsync(cts.Token)
                        : new FileTailer(s, _positions!, sink.Add, status).RunAsync(cts.Token));
                }
                finally
                {
                    cts.Cancel(); // arrête aussi l'envoi par lots
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                status.State = "error";
                status.LastError = ex is System.Net.Sockets.SocketException { SocketErrorCode: System.Net.Sockets.SocketError.AddressAlreadyInUse }
                    ? $"Le port {s.Port} est déjà utilisé par un autre programme."
                    : ex.Message;
                status.LastErrorAt = DateTime.UtcNow;
                log.LogWarning("Source {Name} : {Error}", s.Name, status.LastError);
            }
        }, cts.Token);
        return new Worker(Signature(s), cts, task, status);
    }
}
