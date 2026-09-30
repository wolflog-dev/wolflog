namespace Wolflog.Tests;

/// <summary>Audience web : visiteurs anonymes, sources, événements, entonnoirs et cartes de chaleur.</summary>
public class AnalyticsTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const string Chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private async Task<string> BrowserKey(HttpClient ui)
    {
        var created = await (await ui.PostAsJsonAsync("/api/admin/keys", new { name = "audience", kind = "browser", origins = new[] { "https://boutique.exemple.fr" } }))
            .Content.ReadFromJsonAsync<JsonElement>(Json);
        return created.GetProperty("key").GetString()!;
    }

    private async Task<HttpResponseMessage> SendRum(string key, object body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/v1/rum?k={key}")
        {
            Content = new StringContent(JsonSerializer.Serialize(body, Json), Encoding.UTF8, "text/plain"),
        };
        request.Headers.Add("Origin", "https://boutique.exemple.fr");
        request.Headers.Add("X-Forwarded-For", "203.0.113.7");
        return await server.CreateClient().SendAsync(request);
    }

    /// <summary>Les lignes sont interrogeables dès qu'elles sont dans le WAL, mais on laisse une marge au thread d'écriture.</summary>
    private static async Task<JsonElement> WaitFor(HttpClient ui, string url, Func<JsonElement, bool> ready)
    {
        JsonElement result = default;
        for (var i = 0; i < 50; i++)
        {
            result = await Get(ui, url);
            if (ready(result)) return result;
            await Task.Delay(100);
        }
        return result;
    }

    [Fact]
    public async Task Browser_pageviews_events_and_clicks_become_anonymous_audience()
    {
        var ui = await server.LoggedInClient();
        var key = await BrowserKey(ui);
        var service = "site-" + Guid.NewGuid().ToString("N")[..6];
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 10_000; // dans le passé : la plage interrogée s'arrête à maintenant
        var batch = new
        {
            service, env = "prod", ua = Chrome, lang = "fr-BE", screen = "1920x1080", hostname = "boutique.exemple.fr",
            events = new object[]
            {
                new { type = "page", ts = now, path = "/tarifs", title = "Tarifs", referrer = "https://www.google.com/search?q=boutique",
                      query = "?utm_source=newsletter&utm_campaign=rentree&email=secret@exemple.fr", duration = 900.0 },
                new { type = "track", ts = now + 1000, path = "/tarifs", name = "purchase", data = new { plan = "pro", revenue = 29.9 } },
                new { type = "click", ts = now + 500, path = "/tarifs", x = 0.42, y = 310.0, selector = "button.cta", label = "Choisir", vw = 1280, vh = 800, dh = 1600 },
                new { type = "click", ts = now + 600, path = "/tarifs", x = 0.42, y = 312.0, selector = "button.cta", label = "Choisir", rage = true, vw = 1280, vh = 800, dh = 1600 },
                new { type = "click", ts = now + 700, path = "/tarifs", x = 0.2, y = 600.0, selector = "div.card", dead = true, vw = 1280, vh = 800, dh = 1600 },
                new { type = "scroll", ts = now + 2000, path = "/tarifs", depth = 75, vw = 1280, vh = 800, dh = 1600 },
            },
        };
        Assert.Equal(HttpStatusCode.Accepted, (await SendRum(key, batch)).StatusCode);

        var summary = await WaitFor(ui, $"/api/analytics/summary?from=1h&service={service}",
            s => s.GetProperty("current").GetProperty("pageviews").GetInt64() > 0);
        var current = summary.GetProperty("current");
        Assert.Equal(1, current.GetProperty("visitors").GetInt64());
        Assert.Equal(1, current.GetProperty("pageviews").GetInt64());
        Assert.Equal(1, current.GetProperty("events").GetInt64());
        Assert.Equal(29.9, current.GetProperty("revenue").GetDouble(), 2);

        // Sources : domaine du référent seulement, UTM conservés, autres paramètres d'URL (email) supprimés.
        var referrers = await Get(ui, $"/api/analytics/breakdown?from=1h&service={service}&dimension=referrer");
        Assert.Equal("google.com", referrers[0].GetProperty("value").GetString());
        var campaigns = await Get(ui, $"/api/analytics/breakdown?from=1h&service={service}&dimension=utm_campaign");
        Assert.Equal("rentree", campaigns[0].GetProperty("value").GetString());
        var countries = await Get(ui, $"/api/analytics/breakdown?from=1h&service={service}&dimension=country");
        Assert.Equal("BE", countries[0].GetProperty("value").GetString());
        var browsers = await Get(ui, $"/api/analytics/breakdown?from=1h&service={service}&dimension=browser");
        Assert.Equal("Chrome", browsers[0].GetProperty("value").GetString());
        // Rien de personnel sur disque (WAL compris, ouvert en écriture : lecture partagée).
        static string ReadShared(string file)
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            return reader.ReadToEnd();
        }
        var stored = string.Join('\n', Directory.EnumerateFiles(Path.Combine(server.Storage.DataDirectory, "wal", "analytics")).Select(ReadShared));
        Assert.Contains("boutique.exemple.fr", stored);
        Assert.DoesNotContain("secret@exemple.fr", stored);
        Assert.DoesNotContain("203.0.113.7", stored);

        var props = await Get(ui, $"/api/analytics/events/purchase/properties?from=1h&service={service}");
        Assert.Contains(props.EnumerateArray(), p => p.GetProperty("key").GetString() == "plan" && p.GetProperty("value").GetString() == "pro");

        // Filtre par dimension.
        var filtered = await Get(ui, $"/api/analytics/summary?from=1h&service={service}&f.page=/autre");
        Assert.Equal(0, filtered.GetProperty("current").GetProperty("pageviews").GetInt64());

        var funnel = await Get(ui, $"/api/analytics/funnel?from=1h&service={service}&steps=" +
            Uri.EscapeDataString("""[{"type":"url","value":"/tar*"},{"type":"event","value":"purchase"}]"""));
        Assert.Equal([1L, 1L], funnel.GetProperty("counts").EnumerateArray().Select(c => c.GetInt64()));

        // Cartes de chaleur.
        var pages = await Get(ui, $"/api/analytics/clickmaps?from=1h&service={service}");
        var page = Assert.Single(pages.EnumerateArray());
        Assert.Equal("/tarifs", page.GetProperty("path").GetString());
        Assert.Equal(3, page.GetProperty("clicks").GetInt64());
        var map = await Get(ui, $"/api/analytics/clickmap?from=1h&service={service}&path=/tarifs");
        Assert.Equal(1280, map.GetProperty("width").GetInt32());
        Assert.Equal(1, map.GetProperty("rage").GetInt64());
        Assert.Equal(1, map.GetProperty("dead").GetInt64());
        Assert.Equal("Choisir", map.GetProperty("elements")[0].GetProperty("label").GetString());
        var reach75 = map.GetProperty("scroll").EnumerateArray().First(s => s.GetProperty("depth").GetInt32() == 75);
        Assert.Equal(1.0, reach75.GetProperty("share").GetDouble());
        var frustrations = await Get(ui, $"/api/analytics/frustrations?from=1h&service={service}");
        Assert.Equal("button.cta", frustrations[0].GetProperty("selector").GetString());

        var live = await Get(ui, $"/api/analytics/realtime?service={service}");
        Assert.Equal(1, live.GetProperty("active").GetInt64());
    }

    [Fact]
    public async Task Server_side_events_require_a_server_key()
    {
        var ui = await server.LoggedInClient();
        var browserKey = await BrowserKey(ui);
        var service = "blazor-" + Guid.NewGuid().ToString("N")[..6];
        var batch = new
        {
            service,
            events = new object[]
            {
                new { type = "pageview", path = "/commande?utm_source=blog", title = "Commande", ip = "198.51.100.4", userAgent = Chrome, language = "fr-FR" },
                new { type = "event", path = "/commande", name = "signup", ip = "198.51.100.4", userAgent = Chrome },
                new { type = "pageview", path = "/", ip = "198.51.100.9", userAgent = "curl/8.0" },
            },
        };

        using (var refused = new HttpRequestMessage(HttpMethod.Post, "/v1/analytics") { Content = JsonContent.Create(batch, options: Json) })
        {
            refused.Headers.Add("x-wolflog-key", browserKey);
            Assert.Equal(HttpStatusCode.Unauthorized, (await server.CreateClient().SendAsync(refused)).StatusCode);
        }
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/analytics") { Content = JsonContent.Create(batch, options: Json) };
        request.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
        Assert.Equal(HttpStatusCode.Accepted, (await server.CreateClient().SendAsync(request)).StatusCode);

        var summary = await WaitFor(ui, $"/api/analytics/summary?from=1h&service={service}",
            s => s.GetProperty("current").GetProperty("pageviews").GetInt64() > 0);
        // Le robot (curl) est ignoré ; la page vue et l'événement appartiennent au même visiteur.
        Assert.Equal(1, summary.GetProperty("current").GetProperty("visitors").GetInt64());
        Assert.Equal(1, summary.GetProperty("current").GetProperty("events").GetInt64());
        var sources = await Get(ui, $"/api/analytics/breakdown?from=1h&service={service}&dimension=source");
        Assert.Equal("server", sources[0].GetProperty("value").GetString());
        var utm = await Get(ui, $"/api/analytics/breakdown?from=1h&service={service}&dimension=utm_source");
        Assert.Equal("blog", utm[0].GetProperty("value").GetString());
    }
}
