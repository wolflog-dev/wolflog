using OpenTelemetry.Proto.Collector.Trace.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Trace.V1;

namespace Wolflog.Tests;

/// <summary>Recherche dans les requêtes HTTP (champs, contenu, types de route) et pagination par curseur.</summary>
public class HttpSearchTests
{
    private static readonly DateTime From = DateTime.UtcNow.AddHours(-1);
    private static readonly DateTime To = DateTime.UtcNow.AddHours(1);

    private static Span Request(int n, DateTime at, string method, string path, string? route, int status, double ms,
        string? requestBody = null, string? responseBody = null, string? contentType = null)
    {
        var span = new Span
        {
            TraceId = ByteString.CopyFrom(Convert.FromHexString(n.ToString("x32"))),
            SpanId = ByteString.CopyFrom(BitConverter.GetBytes((long)n + 1)),
            Name = $"{method} {route ?? path}",
            Kind = Span.Types.SpanKind.Server,
            StartTimeUnixNano = Otlp.Nanos(at),
            EndTimeUnixNano = Otlp.Nanos(at.AddMilliseconds(ms)),
            Attributes = { Otlp.Kv("http.request.method", method), Otlp.Kv("url.path", path), Otlp.Kv("http.response.status_code", status.ToString()) },
        };
        if (route != null) span.Attributes.Add(Otlp.Kv("http.route", route));
        if (requestBody != null) span.Attributes.Add(Otlp.Kv("http.request.body", requestBody));
        if (responseBody != null) span.Attributes.Add(Otlp.Kv("http.response.body", responseBody));
        if (contentType != null) span.Attributes.Add(Otlp.Kv("http.response.header.content-type", contentType));
        return span;
    }

    private static async Task<StorageHost> Store(TempDir dir, IEnumerable<Span> spans)
    {
        var storage = Otlp.CreateStorage(dir.Path);
        var scope = new ScopeSpans { Scope = new InstrumentationScope { Name = "Tests" } };
        scope.Spans.AddRange(spans);
        var request = new ExportTraceServiceRequest { ResourceSpans = { new ResourceSpans { Resource = Otlp.Resource("boutique"), ScopeSpans = { scope } } } };
        await storage.Spans.IngestAsync(OtlpConverter.ConvertSpans(request), request.ToByteArray());
        await storage.Spans.FlushAsync();
        return storage;
    }

    private static List<string> Find(QueryService qs, string search) =>
        qs.HttpRequests(From, To, new HttpFilter(null, search, null, null, false), 100, default).Select(r => r.Target).Order().ToList();

    [Fact]
    public async Task Searches_fields_contents_and_route_types()
    {
        using var dir = new TempDir();
        var t = DateTime.UtcNow.AddMinutes(-5);
        await using var storage = await Store(dir,
        [
            Request(1, t, "POST", "/api/orders", "/api/orders", 201, 120, requestBody: """{"panier":"réservation 42"}""", responseBody: """{"id":7}""", contentType: "application/json"),
            Request(2, t.AddSeconds(1), "GET", "/api/orders/7", "/api/orders/{id}", 404, 15, responseBody: "commande introuvable", contentType: "application/json"),
            Request(3, t.AddSeconds(2), "GET", "/healthz", "/healthz", 200, 2),
            Request(4, t.AddSeconds(3), "GET", "/assets/app.4f2a.js", null, 200, 8),
            Request(5, t.AddSeconds(4), "GET", "/commandes", "/commandes", 200, 900, contentType: "text/html; charset=utf-8"),
            Request(6, t.AddSeconds(5), "DELETE", "/api/orders/7", "/api/orders/{id}", 500, 2500, responseBody: "Paiement refusé par la banque"),
        ]);
        var qs = new QueryService(storage);

        // Mots libres : chemin, route, et corps de requête ou de réponse (accents compris).
        Assert.Equal(["/api/orders"], Find(qs, "réservation"));
        Assert.Equal(["/api/orders/7"], Find(qs, "\"commande introuvable\""));
        Assert.Equal(["/api/orders/7"], Find(qs, "réponse:\"paiement refusé\""));
        Assert.Equal(["/api/orders"], Find(qs, "request:panier"));
        Assert.Empty(Find(qs, "request:\"paiement refusé\""));

        // Champs, listes, motifs et exclusions.
        Assert.Equal(["/api/orders", "/api/orders/7"], Find(qs, "method:post,delete"));
        Assert.Equal(["/api/orders/7"], Find(qs, "status:4xx"));
        Assert.Equal(["/api/orders/7"], Find(qs, "status:>=500"));
        Assert.Equal(2, Find(qs, "route:/api/orders/*").Count);
        Assert.Equal(["/api/orders"], Find(qs, "route:/api/orders"));
        // Exclusions : une requête sans route (fichier statique) n'est pas exclue par -route.
        Assert.Equal(["/assets/app.4f2a.js", "/commandes", "/healthz"], Find(qs, "-route:/api/orders/* -status:201"));
        Assert.Equal(["/api/orders/7", "/commandes"], Find(qs, "duration:>500ms"));
        Assert.Equal(["/api/orders/7"], Find(qs, "durée:>=2s"));

        // Types de route.
        Assert.Equal(["/healthz"], Find(qs, "type:health"));
        Assert.Equal(["/assets/app.4f2a.js"], Find(qs, "type:statique"));
        Assert.Equal(["/commandes"], Find(qs, "type:page"));
        Assert.Equal(3, Find(qs, "type:api").Count);
        Assert.Equal(5, Find(qs, "-type:static").Count);
        var kinds = qs.HttpRequests(From, To, new HttpFilter(null, null, null, null, false), 100, default).ToDictionary(r => r.Target + " " + r.Method, r => r.Kind);
        Assert.Equal("api", kinds["/api/orders POST"]);
        Assert.Equal("health", kinds["/healthz GET"]);
    }

    [Fact]
    public async Task Paging_through_requests_with_identical_timestamps_skips_and_repeats_nothing()
    {
        using var dir = new TempDir();
        var t = DateTime.UtcNow.AddMinutes(-5);
        // 25 requêtes, dont 20 à la même microseconde.
        await using var storage = await Store(dir, Enumerable.Range(0, 25).Select(i => Request(i, i < 20 ? t : t.AddSeconds(i), "GET", $"/p/{i}", "/p/{n}", 200, 5)));
        var qs = new QueryService(storage);
        var filter = new HttpFilter(null, null, null, null, false);

        var seen = new List<string>();
        (DateTime, string)? cursor = null;
        while (true)
        {
            var page = qs.HttpRequests(From, To, filter, 7, default, before: cursor);
            seen.AddRange(page.Select(r => r.Target));
            if (page.Count < 7) break;
            cursor = (page[^1].Ts, page[^1].SpanId);
        }
        Assert.Equal(25, seen.Count);
        Assert.Equal(25, seen.Distinct().Count());

        // Dans l'autre sens : les plus récentes que la 10e, dans l'ordre de la liste.
        var all = qs.HttpRequests(From, To, filter, 100, default);
        var newer = qs.HttpRequests(From, To, filter, 100, default, after: (all[9].Ts, all[9].SpanId));
        Assert.Equal(all.Take(9).Select(r => r.SpanId), newer.Select(r => r.SpanId));
    }
}
