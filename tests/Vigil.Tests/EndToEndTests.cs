using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Google.Protobuf;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Serilog;
using Vigil.Client.Internal;
using Vigil.Server.Storage;

namespace Vigil.Tests;

/// <summary>Serveur Vigil complet en mémoire (TestServer), avec authentification activée.</summary>
public sealed class VigilServerFixture : WebApplicationFactory<Program>
{
    public const string ApiKey = "test-api-key-123";
    public const string Password = "test-password";
    private readonly TempDir _dir = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Vigil:DataDirectory", _dir.Path);
        builder.UseSetting("Vigil:Auth:Enabled", "true");
        builder.UseSetting("Vigil:Auth:AdminPassword", Password);
        builder.UseSetting("Vigil:Auth:ApiKeys:0", ApiKey);
        builder.UseSetting("Vigil:Storage:FlushIntervalSeconds", "3600");
    }

    public async Task<HttpClient> LoggedInClient()
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        var login = await client.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = Password });
        login.EnsureSuccessStatusCode();
        return client;
    }

    public StorageHost Storage => Services.GetRequiredService<StorageHost>();

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        _dir.Dispose();
    }
}

public class EndToEndTests(VigilServerFixture server) : IClassFixture<VigilServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private IHost BuildApp(string service, string bufferDir, Func<HttpMessageHandler>? handler = null, Action<IHostApplicationBuilder>? configure = null)
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Logging.ClearProviders();
        builder.AddVigil(o =>
        {
            o.Endpoint = "http://localhost";
            o.ApiKey = VigilServerFixture.ApiKey;
            o.ServiceName = service;
            o.ExportInterval = TimeSpan.FromMilliseconds(200);
            o.MetricsInterval = TimeSpan.FromSeconds(1);
            o.BufferDirectory = bufferDir;
            o.HttpMessageHandlerFactory = handler ?? (() => server.Server.CreateHandler());
        });
        configure?.Invoke(builder);
        return builder.Build();
    }

    private async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static async Task<T> Eventually<T>(Func<Task<T>> probe, Func<T, bool> ok, int seconds = 20)
    {
        var sw = Stopwatch.StartNew();
        while (true)
        {
            var value = await probe();
            if (ok(value) || sw.Elapsed.TotalSeconds > seconds) return value;
            await Task.Delay(200);
        }
    }

    [Fact]
    public async Task Api_requires_login_and_ingestion_requires_api_key()
    {
        var anonymous = server.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/logs")).StatusCode);

        var bad = await anonymous.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = "nope" });
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);

        var body = new ByteArrayContent(Otlp.Logs("x", 1).ToByteArray());
        body.Headers.ContentType = new("application/x-protobuf");
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsync("/v1/logs", body)).StatusCode);

        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/logs") { Content = new ByteArrayContent(Otlp.Logs("auth-ok", 3).ToByteArray()) };
        request.Content.Headers.ContentType = new("application/x-protobuf");
        request.Headers.Add("x-vigil-key", VigilServerFixture.ApiKey);
        var ok = await anonymous.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("application/x-protobuf", ok.Content.Headers.ContentType?.MediaType);

        var client = await server.LoggedInClient();
        var logs = await Get(client, "/api/logs?from=1h&service=auth-ok");
        Assert.Equal(3, logs.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task Otlp_json_is_accepted_with_hex_ids()
    {
        var json = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"json-svc"}}]},
              "scopeLogs":[{"logRecords":[{"timeUnixNano":"TS","severityNumber":17,"body":{"stringValue":"depuis le navigateur"},
                "traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174"}]}]}]}
            """.Replace("TS", Otlp.Nanos(DateTime.UtcNow).ToString());
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/logs") { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
        request.Headers.Add("Authorization", "Bearer " + VigilServerFixture.ApiKey);
        var response = await server.CreateClient().SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var client = await server.LoggedInClient();
        var logs = await Get(client, "/api/logs?from=1h&service=json-svc");
        var item = logs.GetProperty("items")[0];
        Assert.Equal("5b8efff798038103d269b633813fc60c", item.GetProperty("traceId").GetString());
        Assert.Equal("error", item.GetProperty("level").GetString());
    }

    [Fact]
    public async Task Client_library_sends_logs_traces_and_metrics()
    {
        using var buffer = new TempDir();
        var service = "e2e-" + Guid.NewGuid().ToString("N")[..6];
        using (var app = BuildApp(service, buffer.Path))
        {
            await app.StartAsync();
            var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Shop.Orders");
            using var source = new ActivitySource("Vigil.Tests.Orders");
            var tracer = app.Services.GetRequiredService<OpenTelemetry.Trace.TracerProvider>();
            Assert.NotNull(tracer);
            using (var activity = new ActivitySource("Vigil.Tests").StartActivity("Commande"))
            {
                log.LogInformation("Commande {OrderId} validée pour {Amount} €", 42, 99.5);
                log.LogError(new InvalidOperationException("Stock insuffisant"), "Échec de la commande {OrderId}", 43);
            }
            var counter = new System.Diagnostics.Metrics.Meter("Vigil.Tests").CreateCounter<long>("tests.orders");
            counter.Add(5);
            await Task.Delay(1500);
            await app.StopAsync(); // vide les exporteurs
        }

        var client = await server.LoggedInClient();
        var logs = await Eventually(() => Get(client, $"/api/logs?from=1h&service={service}&q=commande"), j => j.GetProperty("items").GetArrayLength() >= 2);
        var items = logs.GetProperty("items").EnumerateArray().ToList();
        var ok = items.Single(i => i.GetProperty("body").GetString()!.Contains("validée"));
        Assert.Equal("Commande 42 validée pour 99.5 €", ok.GetProperty("body").GetString());
        Assert.Equal("Shop.Orders", ok.GetProperty("category").GetString());
        Assert.Contains("\"OrderId\":42", ok.GetProperty("attributes").GetString());
        Assert.NotNull(ok.GetProperty("traceId").GetString());

        var errors = await Get(client, $"/api/errors?from=1h&service={service}");
        var group = errors.EnumerateArray().Single();
        Assert.Equal("System.InvalidOperationException", group.GetProperty("exceptionType").GetString());

        var traces = await Eventually(() => Get(client, $"/api/traces?from=1h&service={service}&q=Commande"), j => j.GetArrayLength() > 0);
        Assert.Equal("Commande", traces[0].GetProperty("rootName").GetString());
        var trace = await Get(client, $"/api/traces/{traces[0].GetProperty("traceId").GetString()}");
        Assert.Equal(2, trace.GetProperty("logs").GetArrayLength());

        var metrics = await Eventually(() => Get(client, $"/api/metrics?from=1h&service={service}"), j => j.EnumerateArray().Any(m => m.GetProperty("name").GetString() == "tests.orders"));
        Assert.Contains(metrics.EnumerateArray(), m => m.GetProperty("name").GetString() == "tests.orders");
        var series = await Get(client, $"/api/metrics/series?from=1h&service={service}&name=tests.orders");
        Assert.Equal("rate", series.GetProperty("stat").GetString());
        Assert.Contains(series.GetProperty("series")[0].GetProperty("values").EnumerateArray(), v => v.ValueKind == JsonValueKind.Number);
    }

    [Fact]
    public async Task Serilog_events_are_forwarded()
    {
        using var buffer = new TempDir();
        var service = "serilog-" + Guid.NewGuid().ToString("N")[..6];
        using (var app = BuildApp(service, buffer.Path, configure: b =>
                   b.Services.AddSerilog((sp, lc) => lc.MinimumLevel.Debug().WriteTo.Vigil(sp))))
        {
            await app.StartAsync();
            var log = app.Services.GetRequiredService<ILogger<EndToEndTests>>();
            log.LogWarning("Via MEL {Value}", 1);
            Serilog.Log.Logger = new LoggerConfiguration().WriteTo.Vigil().CreateLogger();
            Serilog.Log.ForContext("SourceContext", "Direct").Information("Via Serilog {User} {@Order}", "alice", new { Id = 7, Total = 12.5 });
            await Task.Delay(800);
            await app.StopAsync();
        }

        var client = await server.LoggedInClient();
        var logs = await Eventually(() => Get(client, $"/api/logs?from=1h&service={service}&q=via"), j => j.GetProperty("items").GetArrayLength() >= 2);
        var items = logs.GetProperty("items").EnumerateArray().ToList();
        Assert.Contains(items, i => i.GetProperty("body").GetString() == "Via MEL 1" && i.GetProperty("level").GetString() == "warn");
        var direct = items.Single(i => i.GetProperty("category").GetString() == "Direct");
        Assert.Equal("Via Serilog alice { Id: 7, Total: 12.5 }", direct.GetProperty("body").GetString());
        Assert.Contains("\"User\":\"alice\"", direct.GetProperty("attributes").GetString());
    }

    [Fact]
    public async Task Server_down_data_is_buffered_on_disk_then_sent()
    {
        using var buffer = new TempDir();
        var service = "offline-" + Guid.NewGuid().ToString("N")[..6];
        var online = false;
        var handler = new SwitchHandler(() => online, server.Server.CreateHandler());

        using var app = BuildApp(service, buffer.Path, () => handler);
        await app.StartAsync();
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Offline");
        for (var i = 0; i < 20; i++) log.LogInformation("Hors ligne {I}", i);
        await Task.Delay(1500);

        var outbox = Path.Combine(buffer.Path, "outbox");
        Assert.NotEmpty(Directory.GetFiles(outbox, "*.gz"));

        online = true;
        var transport = app.Services.GetRequiredService<VigilTransport>();
        await transport.DrainOutboxAsync(default);
        Assert.Empty(Directory.GetFiles(outbox, "*.gz"));

        var client = await server.LoggedInClient();
        var logs = await Eventually(() => Get(client, $"/api/logs?from=1h&service={service}&q=ligne"), j => j.GetProperty("items").GetArrayLength() >= 20);
        Assert.Equal(20, logs.GetProperty("items").GetArrayLength());
        await app.StopAsync();
    }

    [Fact]
    public async Task Crash_reports_and_abnormal_terminations_appear_as_crashes()
    {
        using var buffer = new TempDir();
        var service = "crash-" + Guid.NewGuid().ToString("N")[..6];

        // Marqueur d'une session "morte" (pid inexistant) : simulera un arrêt brutal précédent.
        var sessions = Path.Combine(buffer.Path, "sessions");
        Directory.CreateDirectory(sessions);
        File.WriteAllText(Path.Combine(sessions, "999999-1.json"), JsonSerializer.Serialize(new
        {
            Pid = 999999,
            ProcessStart = DateTime.UtcNow.AddHours(-1),
            LastSeen = DateTime.UtcNow.AddMinutes(-1),
            Version = "1.0",
            Breadcrumbs = new[] { new { Ts = DateTime.UtcNow, Level = "Information", Category = "X", Message = "dernier log avant la mort" } },
        }));

        using var app = BuildApp(service, buffer.Path);
        await app.StartAsync();

        // Rapport de crash tel qu'écrit par le gestionnaire d'exception non gérée.
        var identity = app.Services.GetRequiredService<ServiceIdentity>();
        Exception ex;
        try { throw new ApplicationException("Boum"); } catch (Exception e) { ex = e; }
        var report = CrashReport.Build(identity, DateTime.UtcNow, ex.GetType().FullName!, ex.Message, ex.ToString(), "Exception non gérée", []);
        var transport = app.Services.GetRequiredService<VigilTransport>();
        transport.Outbox.Store("logs", VigilTransport.Gzip(report.ToByteArray()));
        await transport.DrainOutboxAsync(default);

        var client = await server.LoggedInClient();
        var errors = await Eventually(() => Get(client, $"/api/errors?from=2h&service={service}"), j => j.GetArrayLength() >= 2);
        var types = errors.EnumerateArray().Select(e => e.GetProperty("exceptionType").GetString()).ToList();
        Assert.Contains("System.ApplicationException", types);
        Assert.Contains("Vigil.AbnormalTermination", types);
        Assert.All(errors.EnumerateArray(), e => Assert.Equal(1, e.GetProperty("crashes").GetInt64()));
        Assert.Empty(Directory.GetFiles(sessions, "999999-*"));
        await app.StopAsync();
    }

    [Fact]
    public async Task Live_tail_streams_new_logs()
    {
        var client = await server.LoggedInClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var response = await client.GetAsync("/api/logs/tail?service=tail-svc", HttpCompletionOption.ResponseHeadersRead, cts.Token);
        response.EnsureSuccessStatusCode();
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cts.Token));
        Assert.StartsWith(": connected", await reader.ReadLineAsync(cts.Token));

        var rows = Vigil.Server.Ingestion.OtlpConverter.ConvertLogs(Otlp.Logs("tail-svc", 5));
        await server.Storage.Logs.IngestAsync(rows, default, cts.Token);

        string? line;
        do { line = await reader.ReadLineAsync(cts.Token); } while (line != null && !line.StartsWith("data: "));
        var batch = JsonSerializer.Deserialize<JsonElement>(line!["data: ".Length..]);
        Assert.Equal(5, batch.GetArrayLength());
    }

    [Fact]
    public async Task Overview_and_system_endpoints_work()
    {
        var client = await server.LoggedInClient();
        var overview = await Get(client, "/api/overview?from=1h");
        Assert.True(overview.TryGetProperty("logHistogram", out _));
        var system = await Get(client, "/api/system");
        Assert.Equal(3, system.GetProperty("stores").GetArrayLength());
        var integration = await Get(client, "/api/system/integration");
        Assert.Equal(VigilServerFixture.ApiKey, integration.GetProperty("apiKey").GetString());
    }

    private sealed class SwitchHandler(Func<bool> online, HttpMessageHandler inner) : DelegatingHandler(inner)
    {
        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken ct) =>
            online() ? base.Send(request, ct) : throw new HttpRequestException("Serveur injoignable (simulé)");

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            online() ? base.SendAsync(request, ct) : throw new HttpRequestException("Serveur injoignable (simulé)");
    }
}
