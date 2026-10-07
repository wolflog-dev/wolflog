using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Session;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Wolflog.Client.Blazor;

namespace Wolflog.Tests;

/// <summary>
/// Wolflog.Client.Blazor : pages vues, événements et exceptions envoyés côté serveur, utilisateurs connectés (TrackUsers),
/// aperçu jamais compté, carte de chaleur sur le site.
/// </summary>
[Collection(InstrumentedApps.Name)]
public class BlazorClientTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>NavigationManager d'un circuit Blazor, posé sur une page de l'application.</summary>
    private sealed class TestNavigation : NavigationManager
    {
        public TestNavigation(string uri) => Initialize("https://app.exemple.fr/", uri);
    }

    /// <summary>Session ASP.NET Core en mémoire (comme celle d'une application qui la garde en cache SQL Server).</summary>
    private sealed class TestSession(Dictionary<string, byte[]> values) : ISession
    {
        public bool IsAvailable => true;
        public string Id => "session-de-test";
        public IEnumerable<string> Keys => values.Keys;
        public void Clear() => values.Clear();
        public Task CommitAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task LoadAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public void Remove(string key) => values.Remove(key);
        public void Set(string key, byte[] value) => values[key] = value;
        public bool TryGetValue(string key, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out byte[]? value) => values.TryGetValue(key, out value);
    }

    private async Task<IHost> StartClient(string service, bool trackUsers = false, Action<WolflogBlazorOptions>? configure = null)
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Wolflog:Endpoint"] = server.Server.BaseAddress.ToString(),
            ["Wolflog:ApiKey"] = WolflogServerFixture.ApiKey,
            ["Wolflog:ServiceName"] = service,
        });
        builder.AddWolflogBlazor(o =>
        {
            o.FlushInterval = TimeSpan.FromMilliseconds(50);
            o.TrackUsers = trackUsers;
            configure?.Invoke(o);
        });
        // Le client HTTP du paquet vise le serveur Wolflog en mémoire.
        builder.Services.AddHttpClient(WolflogBlazorExtensions.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => server.Server.CreateHandler());
        var host = builder.Build();
        await host.StartAsync();
        return host;
    }

    private static HttpContext Request(string query = "")
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers.UserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
        ctx.Request.Headers["X-Forwarded-For"] = "192.0.2.44";
        ctx.Request.Headers.AcceptLanguage = "fr-CH,fr;q=0.9";
        ctx.Request.QueryString = new QueryString(query);
        return ctx;
    }

    [Fact]
    public async Task Tracker_sends_pageviews_events_and_component_errors()
    {
        var service = "blazor-app-" + Guid.NewGuid().ToString("N")[..6];
        using var host = await StartClient(service);

        using (var scope = host.Services.CreateScope())
        {
            var visitor = scope.ServiceProvider.GetRequiredService<VisitorContext>();
            visitor.Capture(Request());
            var tracker = ActivatorUtilities.CreateInstance<WolflogTracker>(scope.ServiceProvider, new TestNavigation("https://app.exemple.fr/commande?utm_source=blog"));
            await tracker.TrackPageviewAsync();
            await tracker.TrackAsync("purchase", new { revenue = 49, plan = "pro" });
            await tracker.TrackErrorAsync(new InvalidOperationException("Stock introuvable"), "Pages.Commande");
        }

        var ui = await server.LoggedInClient();
        JsonElement summary = default;
        for (var i = 0; i < 50; i++)
        {
            summary = await ui.GetFromJsonAsync<JsonElement>($"/api/analytics/summary?from=1h&service={service}", Json);
            if (summary.GetProperty("current").GetProperty("events").GetInt64() >= 2) break;
            await Task.Delay(100);
        }
        var current = summary.GetProperty("current");
        Assert.Equal(1, current.GetProperty("visitors").GetInt64());
        Assert.Equal(1, current.GetProperty("pageviews").GetInt64());
        Assert.Equal(2, current.GetProperty("events").GetInt64());
        Assert.Equal(49, current.GetProperty("revenue").GetDouble());

        var countries = await ui.GetFromJsonAsync<JsonElement>($"/api/analytics/breakdown?from=1h&service={service}&dimension=country", Json);
        Assert.Equal("CH", countries[0].GetProperty("value").GetString());
        var props = await ui.GetFromJsonAsync<JsonElement>($"/api/analytics/events/blazor-error/properties?from=1h&service={service}", Json);
        Assert.Contains(props.EnumerateArray(), p => p.GetProperty("key").GetString() == "component" && p.GetProperty("value").GetString() == "Pages.Commande");
    }

    [Fact]
    public async Task Heatmap_preview_is_never_counted()
    {
        var service = "blazor-preview-" + Guid.NewGuid().ToString("N")[..6];
        using var host = await StartClient(service);
        using (var scope = host.Services.CreateScope())
        {
            var visitor = scope.ServiceProvider.GetRequiredService<VisitorContext>();
            visitor.Capture(Request("?wolflog-preview=1"));
            Assert.True(visitor.Preview);
            var tracker = ActivatorUtilities.CreateInstance<WolflogTracker>(scope.ServiceProvider, new TestNavigation("https://app.exemple.fr/?wolflog-preview=1"));
            await tracker.TrackPageviewAsync();
        }
        await Task.Delay(500);
        var ui = await server.LoggedInClient();
        var summary = await ui.GetFromJsonAsync<JsonElement>($"/api/analytics/summary?from=1h&service={service}", Json);
        Assert.Equal(0, summary.GetProperty("current").GetProperty("pageviews").GetInt64());
    }

    private static ClaimsPrincipal SignedIn(params Claim[] claims) => new(new ClaimsIdentity(claims, "Negotiate"));

    [Fact]
    public async Task Signed_in_users_are_counted_with_TrackUsers()
    {
        var service = "blazor-users-" + Guid.NewGuid().ToString("N")[..6];
        using var host = await StartClient(service, trackUsers: true);
        // Deux circuits de Jeanne (deux onglets), un de Paul : même poste, même navigateur.
        foreach (var login in new[] { @"CONTOSO\jdupont", @"contoso\JDUPONT", @"CONTOSO\pmartin" })
        {
            using var scope = host.Services.CreateScope();
            var request = Request();
            request.User = SignedIn(new Claim(ClaimTypes.Name, login));
            scope.ServiceProvider.GetRequiredService<VisitorContext>().Capture(request);
            var tracker = ActivatorUtilities.CreateInstance<WolflogTracker>(scope.ServiceProvider, new TestNavigation("https://app.exemple.fr/conges"));
            await tracker.TrackPageviewAsync();
        }

        var ui = await server.LoggedInClient();
        JsonElement summary = default;
        for (var i = 0; i < 50; i++)
        {
            summary = await ui.GetFromJsonAsync<JsonElement>($"/api/analytics/summary?from=1h&service={service}", Json);
            if (summary.GetProperty("current").GetProperty("pageviews").GetInt64() >= 3) break;
            await Task.Delay(100);
        }
        Assert.Equal(2, summary.GetProperty("current").GetProperty("users").GetInt64());
        Assert.Equal(2, summary.GetProperty("current").GetProperty("visitors").GetInt64());
    }

    [Fact]
    public void User_id_is_sent_only_when_enabled_and_prefers_stable_identifiers()
    {
        var windows = SignedIn(new Claim(ClaimTypes.Name, @"CONTOSO\jdupont"));
        var entra = SignedIn(new Claim(ClaimTypes.Name, "Jeanne Dupont"), new Claim(ClaimTypes.NameIdentifier, "pairwise-sub"),
            new Claim("http://schemas.microsoft.com/identity/claims/objectidentifier", "6f1d0c52-0000-4000-8000-0000000000aa"));

        Assert.Null(new WolflogBlazorOptions().UserOf(windows)); // désactivé par défaut
        var options = new WolflogBlazorOptions { TrackUsers = true };
        Assert.Equal(@"CONTOSO\jdupont", options.UserOf(windows));
        Assert.Equal("6f1d0c52-0000-4000-8000-0000000000aa", options.UserOf(entra));
        Assert.Null(options.UserOf(new ClaimsPrincipal(new ClaimsIdentity()))); // anonyme
        Assert.Null(options.UserOf(null));
        options.UserId = p => p.FindFirst(ClaimTypes.Name)?.Value;
        Assert.Equal("Jeanne Dupont", options.UserOf(entra));
    }

    [Fact]
    public async Task Users_kept_in_the_session_are_counted_with_UserIdFromRequest()
    {
        var service = "blazor-session-" + Guid.NewGuid().ToString("N")[..6];
        // Authentification maison : l'utilisateur est dans la session, HttpContext.User reste anonyme.
        using var host = await StartClient(service, trackUsers: true, o => o.UserIdFromRequest = ctx => ctx.Session.GetString("Login"));
        var options = host.Services.GetRequiredService<IOptions<WolflogBlazorOptions>>().Value;
        foreach (var login in new[] { "jdupont", "JDupont ", "pmartin" })
        {
            using var scope = host.Services.CreateScope();
            var session = new TestSession([]);
            session.SetString("Login", login);
            var request = Request();
            request.Features.Set<ISessionFeature>(new SessionFeature { Session = session });
            var visitor = scope.ServiceProvider.GetRequiredService<VisitorContext>();
            visitor.Capture(request, options);
            Assert.Equal(login.Trim(), visitor.RequestUser);
            var tracker = ActivatorUtilities.CreateInstance<WolflogTracker>(scope.ServiceProvider, new TestNavigation("https://app.exemple.fr/conges"));
            await tracker.TrackPageviewAsync();
        }

        var ui = await server.LoggedInClient();
        JsonElement summary = default;
        for (var i = 0; i < 50; i++)
        {
            summary = await ui.GetFromJsonAsync<JsonElement>($"/api/analytics/summary?from=1h&service={service}", Json);
            if (summary.GetProperty("current").GetProperty("pageviews").GetInt64() >= 3) break;
            await Task.Delay(100);
        }
        Assert.Equal(2, summary.GetProperty("current").GetProperty("users").GetInt64());
    }

    [Fact]
    public void Unreadable_session_leaves_the_user_unknown_without_breaking_the_page()
    {
        // Session non configurée : ctx.Session lève une exception, qui ne doit jamais atteindre l'application.
        var options = new WolflogBlazorOptions { TrackUsers = true, UserIdFromRequest = ctx => ctx.Session.GetString("Login") };
        var visitor = new VisitorContext();
        visitor.Capture(Request(), options);
        Assert.Null(visitor.RequestUser);
        Assert.Null(options.UserFor(visitor));

        // TrackUsers désactivé : la session n'est même pas lue.
        var read = false;
        new VisitorContext().Capture(Request(), new WolflogBlazorOptions { UserIdFromRequest = _ => { read = true; return "jdupont"; } });
        Assert.False(read);
    }

    [Fact]
    public async Task Site_relays_the_browser_script_and_its_measures()
    {
        // Site en HTTPS, Wolflog en HTTP sur une adresse IP : la page charge /_wolflog/wolflog-rum.js et envoie au site lui-même.
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["Wolflog:Endpoint"] = server.Server.BaseAddress.ToString() });
        builder.AddWolflogBlazor();
        builder.Services.AddHttpClient(WolflogBlazorExtensions.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => server.Server.CreateHandler());
        await using var app = builder.Build();
        app.UseWolflogHeatmapPreview();
        await app.StartAsync();
        var site = app.GetTestClient();
        Assert.Contains("wolflog", await site.GetStringAsync("/_wolflog/wolflog-rum.js"));

        var ui = await server.LoggedInClient();
        var key = (await (await ui.PostAsJsonAsync("/api/admin/keys", new { name = "relais", kind = "browser", origins = new[] { "https://app.exemple.fr" } }))
            .Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("key").GetString();
        var service = "relais-" + Guid.NewGuid().ToString("N")[..6];
        // Deux visiteurs derrière le site : chacun garde son adresse (X-Forwarded-For posé par le relais).
        foreach (var ip in new[] { "203.0.113.50", "203.0.113.51" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/_wolflog/v1/rum?k={key}")
            {
                Content = new StringContent(JsonSerializer.Serialize(new
                {
                    service, ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                    events = new object[] { new { type = "page", ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 5000, path = "/accueil" } },
                }, Json), Encoding.UTF8, "text/plain"),
            };
            request.Headers.Add("Origin", "https://app.exemple.fr");
            request.Headers.Add("X-Forwarded-For", ip);
            Assert.Equal(HttpStatusCode.Accepted, (await site.SendAsync(request)).StatusCode);
        }
        JsonElement summary = default;
        for (var i = 0; i < 50; i++)
        {
            summary = await ui.GetFromJsonAsync<JsonElement>($"/api/analytics/summary?from=1h&service={service}", Json);
            if (summary.GetProperty("current").GetProperty("pageviews").GetInt64() >= 2) break;
            await Task.Delay(100);
        }
        Assert.Equal(2, summary.GetProperty("current").GetProperty("visitors").GetInt64());

        // Captures de page aussi relayées. Demande faite par une page du site : GET de même origine, sans en-tête Origin ;
        // le relais le déduit de la page (et transmet le navigateur : un robot n'est jamais sollicité). Venue d'un autre site,
        // elle reste refusée.
        HttpRequestMessage Ask(string fetchSite, string page)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, $"/_wolflog/v1/rum/snapshot?k={key}&service={service}&path=/accueil&vw=1280");
            request.Headers.Add("Sec-Fetch-Site", fetchSite);
            request.Headers.Referrer = new Uri(page);
            request.Headers.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
            return request;
        }
        using var ask = Ask("same-origin", "https://app.exemple.fr/accueil");
        Assert.True((await (await site.SendAsync(ask)).Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("want").GetBoolean());
        using var foreign = Ask("cross-site", "https://autre.exemple.fr/");
        Assert.Equal(HttpStatusCode.Forbidden, (await site.SendAsync(foreign)).StatusCode);
        // Le site ne relaie rien d'autre vers Wolflog.
        Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync("/_wolflog/v1/logs")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await site.PostAsync("/_wolflog/api/admin/keys", null)).StatusCode);
    }

    [Fact]
    public async Task Site_serves_the_heatmap_page_and_relays_its_script_and_clicks()
    {
        // Le site (ici en mémoire) joint Wolflog côté serveur : le navigateur, lui, ne s'adresse qu'au site.
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["Wolflog:Endpoint"] = server.Server.BaseAddress.ToString() });
        builder.AddWolflogBlazor();
        builder.Services.AddHttpClient(WolflogBlazorExtensions.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => server.Server.CreateHandler());
        await using var app = builder.Build();
        app.UseWolflogHeatmapPreview();
        app.MapGet("/", () => "accueil");
        await app.StartAsync();
        var site = app.GetTestClient();

        var page = await site.GetAsync(WolflogHeatmapPreviewExtensions.ViewerPath + "?t=jeton&path=/conges");
        page.EnsureSuccessStatusCode();
        Assert.Equal("text/html", page.Content.Headers.ContentType?.MediaType);
        Assert.Equal("no-store", page.Headers.CacheControl?.ToString());
        // Script servi par le site lui-même : ni contenu mixte (site en HTTPS, Wolflog en HTTP), ni certificat inconnu.
        Assert.Contains("""<script src="/_wolflog/heatmap.js" defer></script>""", await page.Content.ReadAsStringAsync());
        Assert.Contains("api/heatmap/", await site.GetStringAsync("/_wolflog/heatmap.js"));

        // Clics relayés avec le jeton du lien ; sans jeton valable, le refus de Wolflog revient tel quel.
        var ui = await server.LoggedInClient();
        var token = (await (await ui.PostAsync("/api/analytics/clickmap/viewer?from=1h", null)).Content.ReadFromJsonAsync<JsonElement>(Json))
            .GetProperty("token").GetString();
        using var withToken = new HttpRequestMessage(HttpMethod.Get, "/_wolflog/api/heatmap/pages?device=desktop");
        withToken.Headers.Authorization = new("Bearer", token);
        var pages = await site.SendAsync(withToken);
        pages.EnsureSuccessStatusCode();
        Assert.True((await pages.Content.ReadFromJsonAsync<JsonElement>(Json)).TryGetProperty("pages", out _));
        Assert.Equal(HttpStatusCode.Unauthorized, (await site.GetAsync("/_wolflog/api/heatmap/clickmap?path=/conges")).StatusCode);

        // Rien d'autre n'est relayé ; les pages du site passent sans changement.
        Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync("/_wolflog/api/heatmap/../../api/admin/users")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await site.GetAsync("/_wolflog/api/admin/users")).StatusCode);
        Assert.Equal("accueil", await site.GetStringAsync("/"));
    }
}
