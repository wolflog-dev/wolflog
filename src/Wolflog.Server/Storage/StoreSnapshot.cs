using System.Collections.Immutable;

namespace Wolflog.Server.Storage;

/// <summary>Vue cohérente et immuable du stockage à un instant donné (segments sur disque + tables en mémoire).</summary>
public sealed record StoreSnapshot(ImmutableArray<Segment> Segments, ImmutableArray<string> HotTables);
