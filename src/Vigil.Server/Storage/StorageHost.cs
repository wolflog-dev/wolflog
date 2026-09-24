using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Options;

namespace Vigil.Server.Storage;

/// <summary>Regroupe les trois magasins (logs, spans, métriques) et gère leur cycle de vie.</summary>
public sealed class StorageHost : IHostedService, IAsyncDisposable
{
    private readonly VigilServerOptions _options;
    private readonly ILogger<StorageHost> _log;
    private readonly CancellationTokenSource _stop = new();
    private Task? _retentionTask;
    private bool _started;

    public string DataDirectory { get; }
    public DuckDbEngine Engine { get; }
    public SignalStore<LogRow> Logs { get; }
    public SignalStore<SpanRow> Spans { get; }
    public SignalStore<MetricRow> Metrics { get; }
    public LiveTail Tail { get; } = new();
    public IReadOnlyList<ISignalStore> All => [Logs, Spans, Metrics];
    public DateTime StartedAt { get; } = DateTime.UtcNow;

    public StorageHost(IOptions<VigilServerOptions> options, IHostEnvironment env, ILoggerFactory loggers, Hosting.DataDirectoryLock dataLock)
    {
        _options = options.Value;
        _log = loggers.CreateLogger<StorageHost>();
        DataDirectory = _options.ResolveDataDirectory(env.ContentRootPath);
        Directory.CreateDirectory(DataDirectory);
        var s = _options.Storage;
        Engine = new DuckDbEngine(Path.Combine(DataDirectory, "tmp"), s.MemoryLimit, s.Threads);
        var storeLog = loggers.CreateLogger("Vigil.Storage");
        Logs = new SignalStore<LogRow>(LogSchema.Instance, Engine, DataDirectory, s, storeLog) { RowsStored = Tail.Publish };
        Spans = new SignalStore<SpanRow>(SpanSchema.Instance, Engine, DataDirectory, s, storeLog);
        Metrics = new SignalStore<MetricRow>(MetricSchema.Instance, Engine, DataDirectory, s, storeLog);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (_started) return Task.CompletedTask;
        _started = true;
        Logs.Start();
        Spans.Start();
        Metrics.Start();
        _log.LogInformation("Stockage prêt dans {Dir}", DataDirectory);
        _retentionTask = RetentionLoop();
        return Task.CompletedTask;
    }

    private async Task RetentionLoop()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(10));
        try
        {
            do
            {
                try { ApplyRetention(); }
                catch (Exception ex) { _log.LogError(ex, "Rétention en échec"); }
            } while (await timer.WaitForNextTickAsync(_stop.Token).ConfigureAwait(false));
        }
        catch (OperationCanceledException) { }
    }

    public void ApplyRetention()
    {
        var r = _options.Retention;
        var now = DateTime.UtcNow;
        if (r.LogsDays > 0) Logs.ApplyRetention(now.AddDays(-r.LogsDays));
        if (r.TracesDays > 0) Spans.ApplyRetention(now.AddDays(-r.TracesDays));
        if (r.MetricsDays > 0) Metrics.ApplyRetention(now.AddDays(-r.MetricsDays));

        if (r.MaxDiskGb > 0)
        {
            var limit = (long)(r.MaxDiskGb * 1024 * 1024 * 1024);
            var all = All.SelectMany(s => s.Snapshot.Segments.Select(seg => (Store: s, Seg: seg)))
                .OrderBy(x => x.Seg.Index.MaxTs).ToList();
            var total = all.Sum(x => x.Seg.SizeBytes);
            var toRemove = new List<(ISignalStore Store, Segment Seg)>();
            foreach (var x in all)
            {
                if (total <= limit) break;
                toRemove.Add(x);
                total -= x.Seg.SizeBytes;
            }
            foreach (var g in toRemove.GroupBy(x => x.Store))
            {
                g.Key.RemoveSegments(g.Select(x => x.Seg).ToList());
                _log.LogWarning("{Signal}: {Count} segments supprimés (limite disque {Gb} Go)", g.Key.Name, g.Count(), r.MaxDiskGb);
            }
        }
    }

    public long DiskBytes() => All.Sum(s => s.Snapshot.Segments.Sum(x => x.SizeBytes));

    public async Task StopAsync(CancellationToken cancellationToken) => await DisposeAsync();

    private bool _disposed;
    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _stop.Cancel();
        if (_retentionTask != null) await _retentionTask.ConfigureAwait(false);
        if (_started)
        {
            await Task.WhenAll(Logs.DisposeAsync().AsTask(), Spans.DisposeAsync().AsTask(), Metrics.DisposeAsync().AsTask()).ConfigureAwait(false);
        }
        Engine.Dispose();
    }
}

/// <summary>Diffusion en direct des logs reçus vers les clients connectés (SSE).</summary>
public sealed class LiveTail
{
    private readonly ConcurrentDictionary<Guid, Subscriber> _subscribers = new();

    public sealed class Subscriber : IDisposable
    {
        private readonly LiveTail _owner;
        internal readonly Guid Id = Guid.NewGuid();
        internal readonly Func<LogRow, bool> Filter;
        public Channel<LogRow> Channel { get; } = System.Threading.Channels.Channel.CreateBounded<LogRow>(
            new BoundedChannelOptions(2000) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });

        internal Subscriber(LiveTail owner, Func<LogRow, bool> filter)
        {
            _owner = owner;
            Filter = filter;
        }

        public void Dispose() => _owner._subscribers.TryRemove(Id, out _);
    }

    public int Count => _subscribers.Count;

    public Subscriber Subscribe(Func<LogRow, bool> filter)
    {
        var s = new Subscriber(this, filter);
        _subscribers[s.Id] = s;
        return s;
    }

    public void Publish(IReadOnlyList<LogRow> rows)
    {
        if (_subscribers.IsEmpty) return;
        foreach (var s in _subscribers.Values)
            foreach (var r in rows)
                if (s.Filter(r)) s.Channel.Writer.TryWrite(r);
    }
}
