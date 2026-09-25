using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Wolflog.Client;

namespace Wolflog.Tests;

public class FeatureTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static async Task<JsonElement> Eventually(Func<Task<JsonElement>> probe, Func<JsonElement, bool> ok)
    {
        var until = DateTime.UtcNow.AddSeconds(20);
        while (true)
        {
            var v = await probe();
            if (ok(v) || DateTime.UtcNow > until) return v;
            await Task.Delay(200);
        }
    }

    /// <summary>Application ASP.NET Core réelle (TestServer) instrumentée par Wolflog.</summary>
    private async Task<WebApplication> StartApp(string service, string env, string buffer, HttpBodyCapture bodies)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.AddWolflog(o =>
        {
            o.Endpoint = "http://localhost";
            o.ApiKey = WolflogServerFixture.ApiKey;
            o.ServiceName = service;
            o.Environment = env;
            o.ExportInterval = TimeSpan.FromMilliseconds(200);
            o.BufferDirectory = buffer;
            o.Http.Bodies = bodies;
            o.IgnoredPaths.AddRange(["/v1", "/api"]); // serveur Wolflog de test dans le même processus
            o.HttpMessageHandlerFactory = () => server.Server.CreateHandler();
        });
        var app = builder.Build();
        app.MapPost("/login", async (HttpContext ctx) =>
        {
            using var reader = new StreamReader(ctx.Request.Body);
            var body = await reader.ReadToEndAsync(); // l'application lit toujours le corps normalement
            return Results.Json(new { error = "Identifiants refusés", echoLength = body.Length, token = "jwt-secret" }, statusCode: 500);
        });
        app.MapGet("/orders/{id}", (int id) => Results.Ok(new { id, total = 12.5 }));
        await app.StartAsync();
        return app;
    }

    [Fact]
    public async Task Http_bodies_and_headers_are_captured_and_masked()
    {
        using var buffer = new TempDir();
        var service = "capture-" + Guid.NewGuid().ToString("N")[..6];
        await using (var app = await StartApp(service, "prod", buffer.Path, HttpBodyCapture.Errors))
        {
            var client = app.GetTestClient();
            client.DefaultRequestHeaders.Add("Authorization", "Bearer super-secret");
            var login = await client.PostAsync("/login", new StringContent("""{"user":"alice","password":"hunter2"}""", Encoding.UTF8, "application/json"));
            Assert.Equal(500, (int)login.StatusCode);
            var echoed = await login.Content.ReadFromJsonAsync<JsonElement>(Json);
            Assert.Equal(37, echoed.GetProperty("echoLength").GetInt32()); // le corps est resté lisible par l'application
            (await client.GetAsync("/orders/7")).EnsureSuccessStatusCode();
            await Task.Delay(800);
            await app.StopAsync();
        }

        var ui = await server.LoggedInClient();
        var requests = await Eventually(() => Get(ui, $"/api/requests?from=1h&service={service}"), j => j.GetArrayLength() >= 2);
        var failed = requests.EnumerateArray().Single(r => r.GetProperty("route").GetString() == "/login");
        Assert.Equal(500, failed.GetProperty("status").GetInt32());
        Assert.True(failed.GetProperty("error").GetBoolean());
        Assert.True(failed.GetProperty("hasBody").GetBoolean());
        var ok = requests.EnumerateArray().Single(r => r.GetProperty("route").GetString() == "/orders/{id}");
        Assert.False(ok.GetProperty("hasBody").GetBoolean()); // mode "Errors" : pas de corps pour une requête réussie

        var trace = await Get(ui, $"/api/traces/{failed.GetProperty("traceId").GetString()}");
        var attributes = JsonDocument.Parse(trace.GetProperty("spans")[0].GetProperty("attributes").GetString()!).RootElement;
        var requestBody = attributes.GetProperty("http.request.body").GetString()!;
        Assert.Contains("\"user\":\"alice\"", requestBody);
        Assert.DoesNotContain("hunter2", requestBody);
        var responseBody = attributes.GetProperty("http.response.body").GetString()!;
        Assert.Contains("Identifiants refusés", responseBody);
        Assert.DoesNotContain("jwt-secret", responseBody);
        Assert.Equal("***", attributes.GetProperty("http.request.header.authorization").GetString());
        Assert.StartsWith("application/json", attributes.GetProperty("http.response.header.content-type").GetString());

        var summary = await Get(ui, $"/api/requests/summary?from=1h&service={service}");
        Assert.Equal(2, summary.GetProperty("count").GetInt64());
        Assert.Equal(50, summary.GetProperty("errorRate").GetDouble(), 1);

        var series = await Get(ui, $"/api/requests/series?from=1h&service={service}&stat=rate&groupBy=route");
        Assert.Equal(2, series.GetProperty("series").GetArrayLength());
        Assert.Equal("req/s", series.GetProperty("unit").GetString());
    }

    [Fact]
    public async Task Environment_filter_separates_applications()
    {
        using var b1 = new TempDir();
        using var b2 = new TempDir();
        var service = "envapp-" + Guid.NewGuid().ToString("N")[..6];
        foreach (var (env, buffer) in new[] { ("prod", b1.Path), ("staging", b2.Path) })
        {
            await using var app = await StartApp(service, env, buffer, HttpBodyCapture.Off);
            app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Env").LogInformation("Bonjour depuis {Env}", env);
            await app.GetTestClient().GetAsync("/orders/1");
            await Task.Delay(600);
            await app.StopAsync();
        }

        var ui = await server.LoggedInClient();
        var envs = await Eventually(() => Get(ui, "/api/environments"), j => j.EnumerateArray().Any(e => e.GetString() == "staging"));
        Assert.Contains(envs.EnumerateArray(), e => e.GetString() == "prod");
        Assert.Contains(envs.EnumerateArray(), e => e.GetString() == "staging");

        var prodLogs = await Eventually(() => Get(ui, $"/api/logs?from=1h&service={service}&env=prod&q=Bonjour"), j => j.GetProperty("items").GetArrayLength() > 0);
        Assert.All(prodLogs.GetProperty("items").EnumerateArray(), l => Assert.Equal("prod", l.GetProperty("env").GetString()));
        var stagingRequests = await Get(ui, $"/api/requests?from=1h&service={service}&env=staging");
        Assert.Single(stagingRequests.EnumerateArray());
        var services = await Get(ui, "/api/services?from=1h&env=staging");
        Assert.Contains(services.EnumerateArray(), s => s.GetProperty("name").GetString() == service);
    }

    [Fact]
    public async Task Dashboards_can_be_created_edited_and_deleted()
    {
        var ui = await server.LoggedInClient();
        var list = await Get(ui, "/api/dashboards");
        Assert.Contains(list.EnumerateArray(), d => d.GetProperty("id").GetString() == "http"); // tableaux par défaut

        var created = await ui.PostAsJsonAsync("/api/dashboards", new
        {
            name = "Paiements",
            panels = new object[]
            {
                new { title = "Erreurs paiement", type = "logs", query = "paiement", level = "error", width = 12, height = "s" },
                new { title = "p95 /pay", type = "http", stat = "p95", groupBy = "route", query = "/pay", width = 40 },
            },
        });
        created.EnsureSuccessStatusCode();
        var dashboard = await created.Content.ReadFromJsonAsync<JsonElement>(Json);
        var id = dashboard.GetProperty("id").GetString()!;
        Assert.Equal(12, dashboard.GetProperty("panels")[1].GetProperty("width").GetInt32()); // borné à 12 colonnes

        var edited = JsonSerializer.Deserialize<Dictionary<string, object>>(dashboard.GetRawText())!;
        edited["name"] = "Paiements (prod)";
        (await ui.PutAsJsonAsync($"/api/dashboards/{id}", edited)).EnsureSuccessStatusCode();
        Assert.Equal("Paiements (prod)", (await Get(ui, $"/api/dashboards/{id}")).GetProperty("name").GetString());

        (await ui.DeleteAsync($"/api/dashboards/{id}")).EnsureSuccessStatusCode();
        Assert.Equal(System.Net.HttpStatusCode.NotFound, (await ui.GetAsync($"/api/dashboards/{id}")).StatusCode);
    }
}
