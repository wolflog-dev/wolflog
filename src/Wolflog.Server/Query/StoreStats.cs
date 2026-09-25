namespace Wolflog.Server.Query;

public sealed record StoreStats(string Name, long IngestedRows, long HotRows, int Segments, long DiskBytes, DateTime? Oldest);
