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
