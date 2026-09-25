namespace Wolflog.Server.Query;

public sealed record LogPage(IReadOnlyList<LogItem> Items, DateTime? NextBefore, long ElapsedMs, int ScannedSegments, int TotalSegments);
