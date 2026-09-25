using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Wolflog.Server.Sources;

namespace Wolflog.Tests;

public class ParserTests
{
    [Fact]
    public void Syslog_rfc5424_and_rfc3164()
    {
        var a = SyslogParser.Parse("<11>1 2026-09-25T10:00:00.000Z web01 nginx 123 ID47 - Connexion refusée", "10.0.0.1");
        Assert.Equal(17, a.Severity); // 11 % 8 = 3 → erreur
        Assert.Equal("web01", a.Host);
        Assert.Equal("nginx", a.Service);
        Assert.Equal("Connexion refusée", a.Body);
        Assert.Equal(new DateTime(2026, 9, 25, 10, 0, 0, DateTimeKind.Utc), a.Ts);

        var b = SyslogParser.Parse("<38>Sep 25 10:00:00 db01 sshd[4242]: Accepted publickey for deploy", "10.0.0.2");
        Assert.Equal(9, b.Severity); // 38 % 8 = 6 → info
        Assert.Equal("db01", b.Host);
        Assert.Equal("sshd", b.Service);
        Assert.Equal("4242", b.Attributes["process.pid"]);
        Assert.Equal("auth", b.Category); // 38 / 8 = 4
    }

    [Fact]
    public void Iis_w3c_lines_become_http_requests()
    {
        var w3c = new LineParsers.W3C();
        Assert.Null(w3c.Parse("#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken"));
        var e = w3c.Parse("2026-09-25 10:00:01 10.0.0.5 GET /api/orders/42 page=2 443 - 192.168.1.10 Mozilla/5.0+(Windows) - 503 0 0 1250")!;
        Assert.Equal("GET", e.Http!.Method);
        Assert.Equal("/api/orders/42", e.Http.Path);
        Assert.Equal(503, e.Http.Status);
        Assert.Equal(1250, e.Http.DurationMs);
        Assert.Equal("Mozilla/5.0 (Windows)", e.Http.UserAgent);
        Assert.Equal(17, e.Severity);
    }

    [Fact]
    public void Container_and_json_formats()
    {
        var docker = LineParsers.Docker("{\"log\":\"{\\\"level\\\":\\\"warn\\\",\\\"msg\\\":\\\"disque lent\\\"}\\n\",\"stream\":\"stdout\",\"time\":\"2026-09-25T10:00:00Z\"}")!;
        Assert.Equal("disque lent", docker.Body);
        Assert.Equal(13, docker.Severity);

        var cri = LineParsers.Cri("2026-09-25T10:00:00.5Z stderr F panic: nil map")!;
        Assert.Equal("panic: nil map", cri.Body);
        Assert.True(cri.Severity >= 13);

        var pino = LineParsers.Json("{\"level\":50,\"time\":1790000000000,\"msg\":\"échec\",\"orderId\":7}")!;
        Assert.Equal(17, pino.Severity);
        Assert.Equal("7", pino.Attributes["orderId"]);

        var plain = LineParsers.Plain("2026-09-25 10:00:00,123 ERROR [main] Impossible de joindre la base");
        Assert.Equal(17, plain.Severity);
    }

    [Fact]
    public void Serilog_console_and_windows_encoding()
    {
        var e = LineParsers.Plain("[10:18:08 WRN] Paiement refusé");
        Assert.Equal(13, e.Severity);
        Assert.Equal(DateTime.Today.Add(new TimeSpan(10, 18, 8)).ToUniversalTime().TimeOfDay, e.Ts.TimeOfDay);

        byte[] latin1 = [.. System.Text.Encoding.Latin1.GetBytes("calculée")];
        Assert.Equal("calculée", LineParsers.Decode(latin1, latin1.Length));
        byte[] utf8 = [.. System.Text.Encoding.UTF8.GetBytes("calculée")];
        Assert.Equal("calculée", LineParsers.Decode(utf8, utf8.Length));
    }

    [Fact]
    public void Stack_traces_become_exceptions()
    {
        var e = LineParsers.Plain("2026-09-25 10:00:00 ERROR Traitement impossible");
        e.Body += "\nSystem.InvalidOperationException: Commande introuvable\n   at Shop.Orders.Load(Int32 id) in Orders.cs:line 12";
        FileTailer.Finish(e);
        Assert.Equal("System.InvalidOperationException", e.Attributes["exception.type"]);
        Assert.Equal("Commande introuvable", e.Attributes["exception.message"]);
        Assert.Contains("Orders.cs:line 12", e.Attributes["exception.stacktrace"]);
    }
}

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
