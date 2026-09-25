using System.Threading.Channels;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;

namespace Wolflog.Server.Sources;

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
