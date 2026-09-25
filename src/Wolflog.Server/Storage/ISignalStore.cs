namespace Wolflog.Server.Storage;

public interface ISignalStore
{
    string Name { get; }
    StoreSnapshot Snapshot { get; }
    long IngestedRows { get; }
    long HotRows { get; }
    /// <summary>Lots reçus en attente d'écriture (file saturée = disque trop lent).</summary>
    int Backlog { get; }
    DateTime? LastIngestAt { get; }
    DateTime? LastErrorAt { get; }
    string? LastError { get; }
    Task FlushAsync();
    void RemoveSegments(IReadOnlyCollection<Segment> segments);
    Task CompactAsync(bool force = false);
    void ApplyRetention(DateTime cutoff);
}
