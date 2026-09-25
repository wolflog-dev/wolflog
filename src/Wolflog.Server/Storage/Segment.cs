namespace Wolflog.Server.Storage;

public sealed record Segment(string Path, string Partition, SegmentIndex Index, long SizeBytes);
