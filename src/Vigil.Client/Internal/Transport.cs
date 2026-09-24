using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using OpenTelemetry;

namespace Vigil.Client.Internal;

internal enum SendResult { Ok, Retry, Drop }

/// <summary>
/// Envoi vers le serveur Vigil : compression gzip, clé API, et mise en tampon disque
/// quand le serveur est injoignable (renvoi automatique ensuite). L'application n'est jamais bloquée.
/// </summary>
internal sealed class VigilTransport : IDisposable
{
    private readonly HttpClient _http;
    private readonly Uri _base;
    private readonly string? _apiKey;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _drainLock = new(1, 1);
    private long _unavailableUntilTicks;
    private Task? _retryLoop;

    public DiskOutbox Outbox { get; }
    public long SentBatches;
    public long BufferedBatches;
    public long DroppedBatches;

    public VigilTransport(VigilOptions options, string bufferDirectory)
    {
        _base = new Uri(options.Endpoint!.TrimEnd('/') + "/");
        _apiKey = options.ApiKey;
        var handler = options.HttpMessageHandlerFactory?.Invoke() ?? new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            AutomaticDecompression = DecompressionMethods.None,
        };
        _http = new HttpClient(handler) { Timeout = options.Timeout };
        Outbox = new DiskOutbox(bufferDirectory, options.MaxBufferSizeMb * 1024L * 1024L);
    }

    public Uri SignalUri(string signal) => new(_base, "v1/" + signal);

    /// <summary>HttpClient donné aux exporteurs OpenTelemetry : il passe par ce transport.</summary>
    public HttpClient CreateExporterClient() => new(new ExportHandler(this), disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };

    public void StartRetryLoop() => _retryLoop ??= Task.Run(RetryLoop);

    /// <summary>Le serveur a échoué récemment : inutile d'attendre un timeout, on met directement en tampon.</summary>
    private bool CircuitOpen => DateTime.UtcNow.Ticks < Interlocked.Read(ref _unavailableUntilTicks);

    private void MarkUnavailable() => Interlocked.Exchange(ref _unavailableUntilTicks, DateTime.UtcNow.AddSeconds(10).Ticks);

    /// <summary>Envoie un lot (déjà compressé) ; en cas d'échec transitoire il est placé dans le tampon disque.</summary>
    public void Deliver(string signal, byte[] gzipped)
    {
        // Serveur indisponible, ou données plus anciennes en attente (on respecte l'ordre) : directement en tampon.
        var result = CircuitOpen || Outbox.HasPending ? SendResult.Retry : Send(signal, gzipped);

        switch (result)
        {
            case SendResult.Ok:
                Interlocked.Increment(ref SentBatches);
                break;
            case SendResult.Retry:
                Outbox.Store(signal, gzipped);
                Interlocked.Increment(ref BufferedBatches);
                StartRetryLoop();
                break;
            default:
                Interlocked.Increment(ref DroppedBatches);
                break;
        }
    }

    private HttpRequestMessage BuildRequest(string signal, byte[] gzipped)
    {
        var content = new ByteArrayContent(gzipped);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        content.Headers.ContentEncoding.Add("gzip");
        var request = new HttpRequestMessage(HttpMethod.Post, SignalUri(signal)) { Content = content };
        if (!string.IsNullOrEmpty(_apiKey)) request.Headers.TryAddWithoutValidation("x-vigil-key", _apiKey);
        return request;
    }

    public SendResult Send(string signal, byte[] gzipped)
    {
        using var scope = SuppressInstrumentationScope.Begin();
        try
        {
            using var request = BuildRequest(signal, gzipped);
            using var response = _http.Send(request);
            return Classify(response.StatusCode);
        }
        catch (NotSupportedException)
        {
            // Handler personnalisé sans envoi synchrone : repli sur l'asynchrone (thread d'export dédié).
            return Task.Run(() => SendAsync(signal, gzipped, CancellationToken.None)).GetAwaiter().GetResult();
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or IOException)
        {
            MarkUnavailable();
            return SendResult.Retry;
        }
    }

    public async Task<SendResult> SendAsync(string signal, byte[] gzipped, CancellationToken ct)
    {
        using var scope = SuppressInstrumentationScope.Begin();
        try
        {
            using var request = BuildRequest(signal, gzipped);
            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            return Classify(response.StatusCode);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or IOException)
        {
            MarkUnavailable();
            return SendResult.Retry;
        }
    }

    private SendResult Classify(HttpStatusCode status)
    {
        var code = (int)status;
        if (code is >= 200 and < 300) return SendResult.Ok;
        if (code is 408 or 429 or >= 500)
        {
            MarkUnavailable();
            return SendResult.Retry;
        }
        if (code == 401)
            Trace.TraceWarning("Vigil : clé API refusée par le serveur (401). Vérifiez Vigil:ApiKey.");
        // 400, 401, 404, 413… : renvoyer ne servirait à rien.
        return SendResult.Drop;
    }

    /// <summary>Renvoie le contenu du tampon disque. Retourne false si le serveur est toujours indisponible.</summary>
    public async Task<bool> DrainOutboxAsync(CancellationToken ct)
    {
        if (!await _drainLock.WaitAsync(0, ct).ConfigureAwait(false)) return false;
        try
        {
            foreach (var entry in Outbox.Pending())
            {
                ct.ThrowIfCancellationRequested();
                using var claim = Outbox.TryClaim(entry);
                if (claim is null) continue; // un autre processus s'en occupe
                var result = await SendAsync(entry.Signal, claim.Read(), ct).ConfigureAwait(false);
                if (result == SendResult.Retry) return false;
                claim.Complete();
                if (result == SendResult.Ok) Interlocked.Increment(ref SentBatches);
                else Interlocked.Increment(ref DroppedBatches);
            }
            Interlocked.Exchange(ref _unavailableUntilTicks, 0);
            return true;
        }
        finally
        {
            _drainLock.Release();
        }
    }

    /// <summary>Utilisé lors d'un crash : essaie d'envoyer le tampon avant la fin du processus.</summary>
    public void DrainOutboxBlocking(TimeSpan timeout)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
            cts.CancelAfter(timeout);
            Interlocked.Exchange(ref _unavailableUntilTicks, 0);
            Task.Run(() => DrainOutboxAsync(cts.Token)).Wait(timeout);
        }
        catch
        {
            // Le fichier reste dans le tampon : il sera envoyé au prochain démarrage.
        }
    }

    private async Task RetryLoop()
    {
        var delay = TimeSpan.FromSeconds(5);
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                if (Outbox.HasPending)
                {
                    var drained = await DrainOutboxAsync(_stop.Token).ConfigureAwait(false);
                    delay = drained ? TimeSpan.FromSeconds(5) : TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 2, 60));
                }
                await Task.Delay(delay, _stop.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Trace.TraceWarning($"Vigil : erreur lors du renvoi du tampon : {ex.Message}");
                try { await Task.Delay(TimeSpan.FromSeconds(30), _stop.Token).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
            }
        }
    }

    public static byte[] Gzip(ReadOnlySpan<byte> data)
    {
        using var ms = new MemoryStream(data.Length / 3 + 64);
        using (var gz = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true)) gz.Write(data);
        return ms.ToArray();
    }

    /// <summary>Arrête les renvois en arrière-plan (l'envoi direct reste possible pour le vidage final).</summary>
    public void StopRetryLoop()
    {
        _stop.Cancel();
        try { _retryLoop?.Wait(TimeSpan.FromSeconds(2)); } catch { /* arrêt */ }
    }

    public void Dispose()
    {
        StopRetryLoop();
        _http.Dispose();
    }

    /// <summary>
    /// Handler HTTP terminal utilisé par les exporteurs OTLP : il récupère le message protobuf déjà sérialisé
    /// et le confie au transport. Répond toujours "200" : les échecs sont gérés par le tampon disque.
    /// </summary>
    private sealed class ExportHandler(VigilTransport transport) : HttpMessageHandler
    {
        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var (signal, body) = Extract(request, cancellationToken);
            if (signal != null) transport.Deliver(signal, Gzip(body));
            return new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new ByteArrayContent([]) };
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(Send(request, cancellationToken));

        private static (string? Signal, byte[] Body) Extract(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri?.AbsolutePath ?? "";
            string? signal = path.EndsWith("/v1/logs", StringComparison.Ordinal) ? "logs"
                : path.EndsWith("/v1/traces", StringComparison.Ordinal) ? "traces"
                : path.EndsWith("/v1/metrics", StringComparison.Ordinal) ? "metrics"
                : null;
            if (request.Content is null) return (signal, []);
            using var ms = new MemoryStream();
            request.Content.CopyTo(ms, null, ct);
            return (signal, ms.ToArray());
        }
    }
}

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
            Trace.TraceWarning($"Vigil : impossible d'écrire dans le tampon {_dir} : {ex.Message}");
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
