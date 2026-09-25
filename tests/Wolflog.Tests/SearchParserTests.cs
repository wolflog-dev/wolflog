namespace Wolflog.Tests;

public class SearchParserTests
{
    [Fact]
    public void Parses_fields_terms_phrases_and_attributes()
    {
        var q = SearchQuery.Parse("""service:api level:warn host:web-* "connexion refusée" timeout -healthcheck http.route:/users/* trace:ABCDEF""");
        Assert.Equal(["api"], q.Services);
        Assert.Equal(13, q.MinSeverity);
        Assert.Equal(["connexion refusée", "timeout"], q.Terms);
        Assert.Equal(["healthcheck"], q.ExcludedTerms);
        Assert.Contains(("host", "web-*"), q.Columns);
        Assert.Contains(("http.route", "/users/*"), q.Attributes);
        Assert.Equal("abcdef", q.TraceId);
    }

    [Fact]
    public void Prunes_segments_by_index()
    {
        var idx = new SegmentIndex();
        LogSchema.Instance.Index(idx, new LogRow { Ts = DateTime.UtcNow, Service = "api", Severity = 9, Body = "commande validée", TraceId = "aaa" });
        Assert.True(SearchQuery.Parse("service:api validée").MayMatch(idx));
        Assert.False(SearchQuery.Parse("service:worker").MayMatch(idx));
        Assert.False(SearchQuery.Parse("level:error").MayMatch(idx));
        Assert.False(SearchQuery.Parse("paiement").MayMatch(idx));
        Assert.False(SearchQuery.Parse("trace:bbb").MayMatch(idx));
    }

    [Fact]
    public void Matches_in_memory_for_live_tail()
    {
        var row = new LogRow { Service = "api", Severity = 17, Body = "Paiement refusé", Host = "web-1", Attributes = """{"http.route":"/pay/{id}"}""" };
        Assert.True(SearchQuery.Parse("service:api level:error refus host:web-*").Matches(row));
        Assert.True(SearchQuery.Parse("http.route:/pay/*").Matches(row));
        Assert.False(SearchQuery.Parse("level:fatal").Matches(row));
        Assert.False(SearchQuery.Parse("-paiement").Matches(row));
    }

    [Fact]
    public void Histogram_quantile_interpolates()
    {
        double[] bounds = [10, 50, 100];
        long[] counts = [50, 40, 10, 0];
        Assert.Equal(10, QueryService.Quantile(bounds, counts, 0.5)!.Value, 3);
        Assert.InRange(QueryService.Quantile(bounds, counts, 0.95)!.Value, 50, 100);
    }
}
