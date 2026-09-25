using System.Net.Sockets;

namespace Wolflog.Tests;

public class SourceTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static async Task<T> Eventually<T>(Func<Task<T>> probe, Func<T, bool> ok, int seconds = 20)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (true)
        {
            var value = await probe();
            if (ok(value) || DateTime.UtcNow > until) return value;
            await Task.Delay(200);
        }
    }

    [Fact]
    public async Task Files_are_followed_from_iis_and_text_logs()
    {
        using var dir = new TempDir();
        var service = "site-" + Guid.NewGuid().ToString("N")[..6];
        var iis = Path.Combine(dir.Path, "u_ex260925.log");
        var now = DateTime.UtcNow;
        await File.WriteAllTextAsync(iis, "#Software: Microsoft Internet Information Services 10.0\n" +
            "#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken\n");

        var ui = await server.LoggedInClient();
        var preview = await (await ui.PostAsJsonAsync("/api/sources/preview", new { type = "file", path = Path.Combine(dir.Path, "*.log"), format = "auto" }))
            .Content.ReadFromJsonAsync<JsonElement>(Json);
        Assert.Equal(1, preview.GetProperty("total").GetInt32());

        var created = await ui.PostAsJsonAsync("/api/sources", new { name = "IIS", type = "file", path = Path.Combine(dir.Path, "*.log"), format = "auto", service });
        created.EnsureSuccessStatusCode();

        // Lignes écrites après le démarrage de la source (la source démarre en fin de fichier).
        await Task.Delay(4500);
        var stamp = $"{now:yyyy-MM-dd HH:mm:ss}";
        await File.AppendAllTextAsync(iis,
            $"{stamp} 10.0.0.5 GET /api/orders/42 - 443 - 1.2.3.4 curl/8 - 200 0 0 35\n" +
            $"{stamp} 10.0.0.5 POST /api/payments - 443 - 1.2.3.4 curl/8 - 500 0 0 1200\n");
        var app = Path.Combine(dir.Path, "app.log");
        var local = now.ToLocalTime(); // un log texte sans fuseau est en heure locale (IIS, lui, écrit en UTC)
        await File.WriteAllTextAsync(app,
            $"{local:yyyy-MM-dd HH:mm:ss} ERROR Échec du paiement\nSystem.TimeoutException: Délai dépassé\n   at Shop.Pay() in Pay.cs:line 3\n" +
            $"{local:yyyy-MM-dd HH:mm:ss} INFO Reprise\n");

        var requests = await Eventually(() => Get(ui, $"/api/requests?from=1h&service={service}"), j => j.GetArrayLength() == 2);
        Assert.Equal(2, requests.GetArrayLength());
        Assert.Contains(requests.EnumerateArray(), r => r.GetProperty("status").GetInt32() == 500 && r.GetProperty("route").GetString() == "/api/payments");
        Assert.Contains(requests.EnumerateArray(), r => r.GetProperty("route").GetString() == "/api/orders/{id}");

        var errors = await Eventually(() => Get(ui, $"/api/errors?from=1h&service={service}"),
            j => j.GetProperty("items").EnumerateArray().Any(e => e.GetProperty("exceptionType").GetString() == "System.TimeoutException"));
        Assert.Contains(errors.GetProperty("items").EnumerateArray(), e => e.GetProperty("exceptionType").GetString() == "System.TimeoutException");

        var sources = await Get(ui, "/api/sources");
        var status = sources.EnumerateArray().Single(s => s.GetProperty("source").GetProperty("name").GetString() == "IIS").GetProperty("status");
        Assert.Equal(2, status.GetProperty("files").GetInt32());
        Assert.True(status.GetProperty("entries").GetInt64() >= 4);
    }

    [Fact]
    public async Task Syslog_messages_are_received()
    {
        var port = FreePort();
        var service = "rtr" + Guid.NewGuid().ToString("N")[..6];
        var ui = await server.LoggedInClient();
        (await ui.PostAsJsonAsync("/api/sources", new { name = "Syslog", type = "syslog", port, protocol = "udp" })).EnsureSuccessStatusCode();

        using var udp = new UdpClient();
        var logs = await Eventually(async () =>
        {
            var bytes = Encoding.UTF8.GetBytes($"<11>1 {DateTime.UtcNow:O} routeur {service} - - - Lien WAN coupé");
            await udp.SendAsync(bytes, new IPEndPoint(IPAddress.Loopback, port));
            await Task.Delay(700);
            return await Get(ui, $"/api/logs?from=1h&service={service}");
        }, j => j.GetProperty("items").GetArrayLength() > 0);
        var item = logs.GetProperty("items")[0];
        Assert.Equal("Lien WAN coupé", item.GetProperty("body").GetString());
        Assert.Equal("error", item.GetProperty("level").GetString());
        Assert.Equal("routeur", item.GetProperty("host").GetString());
    }

    private static int FreePort()
    {
        using var s = new UdpClient(0);
        return ((IPEndPoint)s.Client.LocalEndPoint!).Port;
    }
}
