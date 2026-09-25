namespace Wolflog.Tests;

public class TrigramTests
{
    [Fact]
    public void Contains_every_substring_of_indexed_text()
    {
        var set = new TrigramSet();
        set.AddText("Connexion refusée par db-primary (timeout=30s)");
        Assert.True(set.MayContain("refus"));
        Assert.True(set.MayContain("db-primary"));
        Assert.True(set.MayContain("TIMEOUT"));
        Assert.True(set.MayContain("ab")); // trop court pour élaguer
        Assert.False(set.MayContain("deadlock"));
        Assert.False(set.MayContain("xyz"));
    }

    [Fact]
    public void Survives_serialization_and_union()
    {
        var a = new TrigramSet();
        a.AddText("alpha");
        var b = new TrigramSet();
        b.AddText("omega");
        a.UnionWith(TrigramSet.FromBase64(b.ToBase64()));
        Assert.True(a.MayContain("alph"));
        Assert.True(a.MayContain("mega"));
        Assert.False(a.MayContain("delta"));
    }

    [Fact]
    public void Bloom_has_no_false_negative()
    {
        var bloom = new BloomFilter();
        var ids = Enumerable.Range(0, 5000).Select(i => Convert.ToHexStringLower(Guid.NewGuid().ToByteArray())).ToList();
        foreach (var id in ids) bloom.Add(id);
        Assert.All(ids, id => Assert.True(bloom.MayContain(id)));
        var falsePositives = Enumerable.Range(0, 5000).Count(_ => bloom.MayContain(Guid.NewGuid().ToString("N")));
        Assert.True(falsePositives < 50, $"{falsePositives} faux positifs");
    }
}
