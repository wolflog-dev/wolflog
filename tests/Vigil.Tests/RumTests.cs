using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Vigil.Tests;

/// <summary>Supervision côté navigateur : script, clé navigateur limitée aux sites autorisés, conversion en logs/spans/métriques.</summary>
public class RumTests(VigilServerFixture server) : IClassFixture<VigilServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private async Task<HttpResponseMessage> Send(string key, string origin, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/v1/rum?k={key}")
        {
            Content = new StringContent(JsonSerializer.Serialize(body, Json), Encoding.UTF8, "text/plain"),
        };
        request.Headers.Add("Origin", origin);
        return await server.CreateClient().SendAsync(request);
    }

    [Fact]
    public async Task Browser_events_become_errors_requests_and_vitals()
    {
        var script = await server.CreateClient().GetAsync("/vigil-rum.js");
        script.EnsureSuccessStatusCode();
        Assert.Contains("sendBeacon", await script.Content.ReadAsStringAsync());

        var ui = await server.LoggedInClient();
        var created = await (await ui.PostAsJsonAsync("/api/admin/keys", new { name = "site", kind = "browser", origins = new[] { "https://boutique.exemple.fr" } }))
            .Content.ReadFromJsonAsync<JsonElement>(Json);
        var key = created.GetProperty("key").GetString()!;
        var service = "front-" + Guid.NewGuid().ToString("N")[..6];
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var trace = "4bf92f3577b34da6a3ce929d0e0e4736";
        var batch = new
        {
            service, env = "prod", session = "abcd1234", ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36",
            events = new object[]
            {
                new { type = "error", ts = now, path = "/panier", name = "TypeError", message = "Cannot read properties of undefined (reading 'prix')",
                      stack = "TypeError: Cannot read properties of undefined (reading 'prix')\n    at total (https://boutique.exemple.fr/app.js:1:2345)" },
                new { type = "page", ts = now, path = "/panier", duration = 1834.0, ttfb = 120.0, domReady = 900.0 },
                new { type = "fetch", ts = now, path = "/panier", method = "GET", url = "https://api.exemple.fr/api/panier/42", host = "api.exemple.fr", status = 503, duration = 250.0, trace, span = "00f067aa0ba902b7" },
                new { type = "vital", ts = now, path = "/panier", name = "lcp", value = 2400.0 },
                new { type = "vital", ts = now, path = "/panier", name = "cls", value = 0.12 },
            },
        };

        // Site non autorisé : refusé.
        Assert.Equal(HttpStatusCode.Forbidden, (await Send(key, "https://pirate.exemple.com", batch)).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await Send(key, "https://boutique.exemple.fr", batch)).StatusCode);
        // Une clé navigateur n'ouvre pas l'ingestion OTLP classique.
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.CreateClient().PostAsync($"/v1/logs?k={key}", new ByteArrayContent([]))).StatusCode);

        JsonElement errors = default;
        for (var i = 0; i < 50; i++)
        {
            errors = await Get(ui, $"/api/errors?from=1h&service={service}");
            if (errors.GetProperty("items").GetArrayLength() > 0) break;
            await Task.Delay(100);
        }
        Assert.Equal("TypeError", errors.GetProperty("items")[0].GetProperty("exceptionType").GetString());

        // L'appel réseau garde l'identifiant de trace injecté : il rejoint la trace du serveur appelé.
        var calls = await Get(ui, $"/api/requests?from=1h&service={service}&direction=out");
        var call = Assert.Single(calls.EnumerateArray());
        Assert.Equal(trace, call.GetProperty("traceId").GetString());
        Assert.Equal(503, call.GetProperty("status").GetInt32());

        var lcp = await Get(ui, $"/api/query?from=1h&source=metrics&filter=name:browser.web_vital.lcp&agg=p75&field=value&view=stat&service={service}");
        Assert.Equal(2400, lcp.GetProperty("value").GetDouble(), 1);
        var jsErrors = await Get(ui, $"/api/query?from=1h&source=logs&filter=log.category:navigateur&agg=count&view=stat&service={service}");
        Assert.Equal(1, jsErrors.GetProperty("value").GetDouble());
        var browsers = await Get(ui, $"/api/query?from=1h&source=spans&filter=browser.name:*&agg=count&groupBy=browser.name&view=top&service={service}");
        Assert.Equal("Chrome", browsers.GetProperty("rows")[0].GetProperty("group").GetString());

        var dashboards = await Get(ui, "/api/dashboards");
        Assert.Contains(dashboards.EnumerateArray(), d => d.GetProperty("id").GetString() == "browser");
    }
}
