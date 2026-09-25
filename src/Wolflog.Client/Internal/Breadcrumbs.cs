using SdkLogRecord = OpenTelemetry.Logs.LogRecord;

namespace Wolflog.Client.Internal;

/// <summary>Les derniers logs émis, joints aux rapports de crash pour comprendre ce qui s'est passé juste avant.</summary>
internal sealed class Breadcrumbs : BaseProcessor<SdkLogRecord>
{
    public sealed record Crumb(DateTime Ts, string Level, string? Category, string Message);

    private const int Capacity = 40;
    private readonly Crumb?[] _ring = new Crumb?[Capacity];
    private readonly object _lock = new(); // net8 : pas de System.Threading.Lock
    private int _next;
    private long _version;

    public long Version => Interlocked.Read(ref _version);

    public override void OnEnd(SdkLogRecord data)
    {
        var message = data.FormattedMessage ?? data.Body ?? "";
        if (message.Length > 500) message = message[..500] + "…";
        if (data.Exception != null) message += $" [{data.Exception.GetType().Name}: {data.Exception.Message}]";
        var crumb = new Crumb(data.Timestamp, data.LogLevel.ToString(), data.CategoryName, message);
        lock (_lock)
        {
            _ring[_next] = crumb;
            _next = (_next + 1) % Capacity;
        }
        Interlocked.Increment(ref _version);
    }

    public List<Crumb> Snapshot()
    {
        lock (_lock)
        {
            var list = new List<Crumb>(Capacity);
            for (var i = 0; i < Capacity; i++)
            {
                var c = _ring[(_next + i) % Capacity];
                if (c != null) list.Add(c);
            }
            return list;
        }
    }
}
