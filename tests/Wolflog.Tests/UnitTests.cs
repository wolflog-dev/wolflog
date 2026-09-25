using Wolflog.Server.Ingestion;
using Wolflog.Server.Query;
using Wolflog.Server.Storage;

namespace Wolflog.Tests;

public class FingerprintTests
{
    private const string Stack1 = """
        System.InvalidOperationException: Client introuvable (id=12)
           at Shop.Orders.OrderService.Load(Int32 id) in C:\src\Shop\OrderService.cs:line 42
           at Shop.Orders.OrderService.<GetAsync>b__12_0() in C:\src\Shop\OrderService.cs:line 30
           at Shop.Api.Program.<Main>b__0_1(Int32 id)
        """;

    private const string Stack2 = """
        System.InvalidOperationException: Client introuvable (id=99)
           at Shop.Orders.OrderService.Load(Int32 id) in /app/src/Shop/OrderService.cs:line 44
           at Shop.Orders.OrderService.<GetAsync>b__13_0() in /app/src/Shop/OrderService.cs:line 31
           at Shop.Api.Program.<Main>b__0_1(Int32 id)
        """;

    [Fact]
    public void Same_problem_same_fingerprint_despite_lines_ids_and_paths()
    {
        var a = Fingerprint.Compute("System.InvalidOperationException", "Client introuvable (id=12)", Stack1);
        var b = Fingerprint.Compute("System.InvalidOperationException", "Client introuvable (id=99)", Stack2);
        Assert.Equal(a, b);
        Assert.Equal(16, a.Length);
    }

    [Fact]
    public void Framework_frames_do_not_split_groups()
    {
        // Cas réel : la frame EndpointMiddleware n'apparaît pas toujours (inlining du JIT).
        const string a = """
            System.InvalidOperationException: Client introuvable (id=31)
               at Program.<>c.<<Main>$>b__0_5(ILogger`1 log) in C:\Demo\Program.cs:line 51
               at lambda_method4(Closure, Object, HttpContext)
               at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
            """;
        const string b = """
            System.InvalidOperationException: Client introuvable (id=7)
               at Program.<>c.<<Main>$>b__0_5(ILogger`1 log) in C:\Demo\Program.cs:line 51
               at lambda_method4(Closure, Object, HttpContext)
               at Microsoft.AspNetCore.Routing.EndpointMiddleware.Invoke(HttpContext httpContext)
               at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
            """;
        Assert.Equal(
            Fingerprint.Compute("System.InvalidOperationException", null, a),
            Fingerprint.Compute("System.InvalidOperationException", null, b));
    }

    [Fact]
    public void Wolflog_capture_middleware_frame_is_ignored()
    {
        const string withCapture = """
            System.InvalidOperationException: x
               at Program.<>c.<<Main>$>b__0_6(ILogger`1 log) in C:\Demo\Program.cs:line 62
               at Microsoft.AspNetCore.Routing.EndpointRoutingMiddleware.Invoke(HttpContext httpContext)
               at Wolflog.Client.Internal.HttpCaptureStartupFilter.Capture(HttpContext ctx, RequestDelegate next) in C:\Wolflog\HttpCapture.cs:line 116
            """;
        const string without = """
            System.InvalidOperationException: y
               at Program.<>c.<<Main>$>b__0_6(ILogger`1 log) in C:\Demo\Program.cs:line 62
               at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
            """;
        Assert.Equal(
            Fingerprint.Compute("System.InvalidOperationException", null, withCapture),
            Fingerprint.Compute("System.InvalidOperationException", null, without));
    }

    [Fact]
    public void Different_type_different_fingerprint()
    {
        var a = Fingerprint.Compute("System.InvalidOperationException", null, Stack1);
        var b = Fingerprint.Compute("System.ArgumentException", null, Stack1);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void Without_stack_message_is_normalized()
    {
        var a = Fingerprint.Compute("TimeoutException", "Timeout after 30 s on 'db-1' (id 3f2504e0-4f89-11d3-9a0c-0305e82c3301)", null);
        var b = Fingerprint.Compute("TimeoutException", "Timeout after 45 s on 'db-2' (id 7c9e6679-7425-40de-944b-e07fc1f90ae7)", null);
        Assert.Equal(a, b);
    }
}

public class SpanNameTests
{
    [Theory]
    [InlineData("/api/orders/341", "/api/orders/{id}")]
    [InlineData("/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301/cart", "/users/{guid}/cart")]
    [InlineData("/blobs/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b?x=1", "/blobs/{hash}")]
    [InlineData("/api/v2/health", "/api/v2/health")]
    public void Client_paths_are_templated(string path, string expected) =>
        Assert.Equal(expected, OtlpConverter.TemplatePath(path));
}

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

public class IgnoredPathsTests
{
    [Theory]
    [InlineData("/health", false)]
    [InlineData("/health/ready", false)]
    [InlineData("/healthy", true)]
    [InlineData("/api/orders", true)]
    public void Ignored_paths_are_not_exported(string path, bool exported)
    {
        using var source = new System.Diagnostics.ActivitySource("test-ignored-paths");
        using var listener = new System.Diagnostics.ActivityListener
        {
            ShouldListenTo = s => s.Name == "test-ignored-paths",
            Sample = (ref System.Diagnostics.ActivityCreationOptions<System.Diagnostics.ActivityContext> _) => System.Diagnostics.ActivitySamplingResult.AllDataAndRecorded,
        };
        System.Diagnostics.ActivitySource.AddActivityListener(listener);
        using var activity = source.StartActivity("GET", System.Diagnostics.ActivityKind.Server)!;
        activity.SetTag("url.path", path);
        new Wolflog.Client.Internal.IgnoredPathsProcessor(new Wolflog.Client.WolflogOptions()).OnEnd(activity);
        Assert.Equal(exported, activity.Recorded);
    }
}
