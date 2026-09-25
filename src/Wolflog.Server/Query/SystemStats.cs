namespace Wolflog.Server.Query;

public sealed record SystemStats(DateTime StartedAt, string DataDirectory, long DiskBytes, long MemoryBytes, int LiveTailClients, IReadOnlyList<StoreStats> Stores, string Version);
