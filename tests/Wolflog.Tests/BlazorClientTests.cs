using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Wolflog.Client.Blazor;

namespace Wolflog.Tests;

/// <summary>Wolflog.Client.Blazor : pages vues, événements et exceptions envoyés côté serveur, aperçu jamais compté.</summary>
[Collection(InstrumentedApps.Name)]
public class BlazorClientTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>NavigationManager d'un circuit Blazor, posé sur une page de l'application.</summary>
    private sealed class TestNavigation : NavigationManager
    {
        public TestNavigation(string uri) => Initialize("https://app.exemple.fr/", uri);
    }

    private async Task<IHost> StartClient(string service)
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Wolflog:Endpoint"] = server.Server.BaseAddress.ToString(),
            ["Wolflog:ApiKey"] = WolflogServerFixture.ApiKey,
            ["Wolflog:ServiceName"] = service,
        });
        builder.AddWolflogBlazor(o => o.FlushInterval = TimeSpan.FromMilliseconds(50));
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
}
