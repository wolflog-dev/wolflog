using System.Threading.Channels;

namespace Wolflog.Server.Storage;

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
