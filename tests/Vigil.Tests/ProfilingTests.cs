using System.Net.Http.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System.Runtime.CompilerServices;
using Vigil.Client.Profiling;

namespace Vigil.Tests;

public class ProfilerTests
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static double BusyLoopForProfiler(TimeSpan duration)
    {
        var until = DateTime.UtcNow + duration;
        double x = 0;
        while (DateTime.UtcNow < until)
            for (var i = 1; i < 10_000; i++) x += Math.Sqrt(i) * Math.Sin(i);
        return x;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int AllocateForProfiler(TimeSpan duration)
    {
        var until = DateTime.UtcNow + duration;
        var kept = 0;
        while (DateTime.UtcNow < until)
        {
            var buffer = new byte[64 * 1024];
            kept += buffer.Length > 0 ? 1 : 0;
        }
        return kept;
    }

    [Fact]
    public async Task Cpu_profile_finds_the_busy_method()
    {
        var busy = Task.Run(() => BusyLoopForProfiler(TimeSpan.FromSeconds(4)));
        var result = await Profiler.RunAsync("cpu", TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        await busy;
        Assert.True(result.Samples > 50, $"{result.Samples} échantillons");
        var hot = result.Stacks.Where(kv => kv.Key.Contains(nameof(BusyLoopForProfiler))).Sum(kv => kv.Value);
        // D'autres tests tournent en parallèle : la méthode chaude doit peser, sans forcément dominer.
        Assert.True(hot > result.Samples / 20, $"{hot} sur {result.Samples}");
        var top = result.Stacks.OrderByDescending(kv => kv.Value).Take(5).Select(kv => kv.Key);
        Assert.Contains(top, k => k.Contains(nameof(BusyLoopForProfiler)));
    }

    [Fact]
    public async Task Allocation_profile_names_the_allocated_type()
    {
        var work = Task.Run(() => AllocateForProfiler(TimeSpan.FromSeconds(4)));
        var result = await Profiler.RunAsync("alloc", TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        await work;
        Assert.Contains(result.Stacks.Keys, k => k.Contains(nameof(AllocateForProfiler)) && k.EndsWith("[System.Byte[]]"));
    }
}

public class ProfilingFlowTests(VigilServerFixture server) : IClassFixture<VigilServerFixture>
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
        builder.AddVigil(o =>
        {
            o.Endpoint = "http://localhost";
            o.ApiKey = VigilServerFixture.ApiKey;
            o.ServiceName = service;
            o.BufferDirectory = buffer.Path;
            o.Traces = false;
            o.Metrics = false;
            o.HttpMessageHandlerFactory = () => server.Server.CreateHandler();
        });
        builder.AddVigilProfiling();
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
        forged.Headers.Add("x-vigil-key", VigilServerFixture.ApiKey);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, (await server.CreateClient().SendAsync(forged)).StatusCode);
        await app.StopAsync(TestContext.Current.CancellationToken);
    }
}
