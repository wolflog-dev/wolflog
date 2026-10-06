namespace Wolflog.Tests;

public class SegmentIndexTests
{
    private const string TraceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    [Fact]
    public void Trace_filter_is_allocated_only_when_a_trace_id_is_added()
    {
        var index = new SegmentIndex();
        index.AddTraceId(null);
        index.AddTraceId("");
        Assert.Null(index.TraceIds); // métriques, audience : plus de filtre de 32 Ko par segment
        Assert.False(index.MayContainTraceId(TraceId));

        index.AddTraceId(TraceId);
        Assert.NotNull(index.TraceIds);
        Assert.True(index.MayContainTraceId(TraceId));
    }

    [Fact]
    public void Survives_serialization_with_or_without_trace_ids()
    {
        var withoutIds = new SegmentIndex();
        withoutIds.AddTimestamp(DateTime.UtcNow);
        var withIds = new SegmentIndex();
        withIds.AddTraceId(TraceId);

        var reloadedWithout = JsonSerializer.Deserialize<SegmentIndex>(JsonSerializer.SerializeToUtf8Bytes(withoutIds))!;
        var reloadedWith = JsonSerializer.Deserialize<SegmentIndex>(JsonSerializer.SerializeToUtf8Bytes(withIds))!;

        Assert.Null(reloadedWithout.TraceIds);
        Assert.True(reloadedWith.MayContainTraceId(TraceId));
    }

    [Fact]
    public void Empty_filter_of_an_older_index_is_not_loaded()
    {
        // Index écrit quand chaque segment avait un filtre, même vide (métriques, audience).
        var json = JsonSerializer.Serialize(new { Rows = 10, TraceIdsData = new BloomFilter().ToBase64() });
        var index = JsonSerializer.Deserialize<SegmentIndex>(json)!;

        Assert.Null(index.TraceIds);
        Assert.False(index.MayContainTraceId(TraceId)); // même élagage qu'avec le filtre vide
    }

    [Fact]
    public void Merge_keeps_trace_ids_from_either_side()
    {
        var merged = new SegmentIndex();
        merged.Merge(new SegmentIndex());
        Assert.Null(merged.TraceIds);

        var withIds = new SegmentIndex();
        withIds.AddTraceId(TraceId);
        merged.Merge(withIds);
        Assert.True(merged.MayContainTraceId(TraceId));
    }

    [Fact]
    public void Unknown_index_may_contain_any_trace()
    {
        var index = SegmentIndex.Unknown(DateTime.MinValue, DateTime.MaxValue, 1, ["api"]);
        Assert.True(index.MayContainTraceId(TraceId));
    }
}
