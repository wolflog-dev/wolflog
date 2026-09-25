using Wolflog.Client.Profiling;

namespace Wolflog.Tests;

public class ProfilingFlowTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly System.Text.Json.JsonSerializerOptions Json = new(System.Text.Json.JsonSerializerDefaults.Web);

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static double HotPathForRemoteProfile(TimeSpan duration)
    {
        var until = DateTime.UtcNow + duration;
        double x = 0;
        while (DateTime.UtcNow < until)
            for (var i = 1; i < 10_000; i++) x += Math.Sqrt(i);
        return x;
    }

    [Fact]
    public async Task Profile_requested_from_the_ui_is_captured_by_the_application()
    {
        ProfilingAgent.FirstPoll = TimeSpan.FromMilliseconds(100);
        ProfilingAgent.PollInterval = TimeSpan.FromMilliseconds(300);
        var service = "prof-" + Guid.NewGuid().ToString("N")[..6];
        using var buffer = new TempDir();
        var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder();
        builder.Logging.ClearProviders();
        builder.AddWolflog(o =>
        {
            o.Endpoint = "http://localhost";
            o.ApiKey = WolflogServerFixture.ApiKey;
            o.ServiceName = service;
            o.BufferDirectory = buffer.Path;
            o.Traces = false;
            o.Metrics = false;
            o.HttpMessageHandlerFactory = () => server.Server.CreateHandler();
        });
        builder.AddWolflogProfiling();
        using var app = builder.Build();
        await app.StartAsync(TestContext.Current.CancellationToken);

        var ui = await server.LoggedInClient();
        // L'instance se déclare disponible.
        System.Text.Json.JsonElement instances = default;
        for (var i = 0; i < 50; i++)
        {
            instances = await ui.GetFromJsonAsync<System.Text.Json.JsonElement>("/api/profiling/instances", Json);
            if (instances.EnumerateArray().Any(x => x.GetProperty("service").GetString() == service)) break;
            await Task.Delay(100);
        }
        Assert.Contains(instances.EnumerateArray(), x => x.GetProperty("service").GetString() == service);

        var requested = await (await ui.PostAsJsonAsync("/api/profiles", new { service, kind = "cpu", seconds = 5 }))
            .Content.ReadFromJsonAsync<System.Text.Json.JsonElement>(Json);
        var id = requested.GetProperty("id").GetString()!;
        var busy = Task.Run(() => HotPathForRemoteProfile(TimeSpan.FromSeconds(7)));

        System.Text.Json.JsonElement profile = default;
        for (var i = 0; i < 120; i++)
        {
            profile = await ui.GetFromJsonAsync<System.Text.Json.JsonElement>($"/api/profiles/{id}", Json);
            if (profile.GetProperty("info").GetProperty("status").GetString() is "done" or "failed") break;
            await Task.Delay(250);
        }
        await busy;
        Assert.Equal("done", profile.GetProperty("info").GetProperty("status").GetString());
        Assert.Contains(profile.GetProperty("stacks").EnumerateArray(), s => s.GetProperty("s").GetString()!.Contains(nameof(HotPathForRemoteProfile)));

        // Un envoi qui ne correspond à aucune demande est refusé.
        using var forged = new HttpRequestMessage(HttpMethod.Post, "/v1/profiles") { Content = JsonContent.Create(new { id = "../../evil", service }) };
        forged.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, (await server.CreateClient().SendAsync(forged)).StatusCode);
        await app.StopAsync(TestContext.Current.CancellationToken);
    }
}
