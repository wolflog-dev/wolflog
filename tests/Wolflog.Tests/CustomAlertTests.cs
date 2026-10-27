using System.Globalization;
using System.Net.Http.Headers;
using OpenTelemetry.Proto.Collector.Trace.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Trace.V1;
using Wolflog.Server.Monitoring;

namespace Wolflog.Tests;

/// <summary>Alertes personnalisées (réponse HTTP, regroupement, sondes, erreurs fréquentes), plages d'activité, sondes à heures fixes.</summary>
public class CustomAlertTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static async Task<JsonElement> Post(HttpClient client, string url, object body)
    {
        var response = await client.PostAsJsonAsync(url, body);
        if (!response.IsSuccessStatusCode) Assert.Fail($"{url} : {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var text = await response.Content.ReadAsStringAsync();
        return string.IsNullOrEmpty(text) ? default : JsonSerializer.Deserialize<JsonElement>(text, Json);
    }

    private async Task Send(string path, byte[] body)
    {
        using var content = new ByteArrayContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        using var message = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };
        message.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
        (await server.CreateClient().SendAsync(message)).EnsureSuccessStatusCode();
    }

    private static Span Request(int n, DateTime at, string method, string path, string route, int status, double ms, string? responseBody = null)
    {
        var span = new Span
        {
            TraceId = ByteString.CopyFrom(Guid.NewGuid().ToByteArray()),
            SpanId = ByteString.CopyFrom(BitConverter.GetBytes((long)n + 1)),
            Name = $"{method} {route}",
            Kind = Span.Types.SpanKind.Server,
            StartTimeUnixNano = Otlp.Nanos(at),
            EndTimeUnixNano = Otlp.Nanos(at.AddMilliseconds(ms)),
            Attributes =
            {
                Otlp.Kv("http.request.method", method), Otlp.Kv("url.path", path), Otlp.Kv("http.route", route),
                Otlp.Kv("http.response.status_code", status.ToString(CultureInfo.InvariantCulture)),
            },
        };
        if (responseBody != null) span.Attributes.Add(Otlp.Kv("http.response.body", responseBody));
        return span;
    }

    private Task SendRequests(string service, IEnumerable<Span> spans)
    {
        var scope = new ScopeSpans { Scope = new InstrumentationScope { Name = "Tests" } };
        scope.Spans.AddRange(spans);
        var request = new ExportTraceServiceRequest { ResourceSpans = { new ResourceSpans { Resource = Otlp.Resource(service), ScopeSpans = { scope } } } };
        return Send("/v1/traces", request.ToByteArray());
    }

    private static (string Key, bool Breach, double? Value, string Message)[] Evaluations(JsonElement preview) =>
        preview.EnumerateArray().Select(e => (e.GetProperty("key").GetString()!, e.GetProperty("breach").GetBoolean(),
            e.GetProperty("value").ValueKind == JsonValueKind.Number ? e.GetProperty("value").GetDouble() : (double?)null,
            e.GetProperty("message").GetString()!)).ToArray();

    [Fact]
    public void Weekly_hours_handle_days_and_overnight_ranges()
    {
        var monday = new DateTime(2026, 10, 26); // lundi
        int[] weekdays = [1, 2, 3, 4, 5];
        Assert.True(WeeklyHours.IsActive(weekdays, "08:00", "19:00", monday.AddHours(8)));
        Assert.False(WeeklyHours.IsActive(weekdays, "08:00", "19:00", monday.AddHours(19)));
        Assert.False(WeeklyHours.IsActive(weekdays, "08:00", "19:00", monday.AddDays(-1).AddHours(12))); // dimanche
        Assert.True(WeeklyHours.IsActive(null, null, null, monday.AddDays(-1).AddHours(3)));
        // 22:00 → 06:00 du lundi au vendredi : la nuit de vendredi à samedi oui, celle de dimanche à lundi non.
        Assert.True(WeeklyHours.IsActive(weekdays, "22:00", "06:00", monday.AddDays(5).AddHours(2)));
        Assert.False(WeeklyHours.IsActive(weekdays, "22:00", "06:00", monday.AddHours(2)));
        Assert.True(WeeklyHours.IsActive(weekdays, "22:00", "06:00", monday.AddHours(23)));

        // Heures fixes : la suivante, le jour même ou un jour coché plus tard.
        Assert.Equal(monday.AddHours(12), WeeklyHours.Next(["08:00", "12:00"], null, monday.AddHours(8)));
        Assert.Equal(monday.AddDays(4).AddHours(8), WeeklyHours.Next(["8:00"], [5], monday.AddHours(9)));
        Assert.Null(WeeklyHours.Next(["25:00"], null, monday));
        Assert.Equal("08:05", WeeklyHours.Normalize("8:05"));
    }

    [Fact]
    public async Task Http_alerts_measure_any_response_condition_per_group()
    {
        var service = "svc-http-" + Guid.NewGuid().ToString("N")[..6];
        var t = DateTime.UtcNow.AddMinutes(-1);
        var spans = new List<Span>();
        for (var i = 0; i < 20; i++)
            spans.Add(Request(i, t.AddMilliseconds(i), "GET", $"/api/orders/{i}", "/api/orders/{id}", i < 5 ? 404 : 200, 10 + i));
        for (var i = 0; i < 10; i++)
            spans.Add(Request(100 + i, t.AddMilliseconds(i), "POST", "/api/cart", "/api/cart", i < 3 ? 409 : 201, 900, i < 3 ? """{"erreur":"stock insuffisant"}""" : null));
        await SendRequests(service, spans);
        var ui = await server.LoggedInClient();

        // Part des réponses 4xx parmi les requêtes du service : 8 sur 30.
        var percent = Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "http", service, stat = "percent", match = "status:4xx", threshold = 20, windowMinutes = 5 }));
        var total = Assert.Single(percent);
        Assert.Equal(100.0 * 8 / 30, total.Value!.Value, 3);
        Assert.True(total.Breach);
        Assert.Contains("8 sur 30 requêtes", total.Message);

        // Nombre de réponses contenant un texte, sur une route : 3.
        var count = Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "http", service, stat = "count", route = "route:/api/cart", match = "response:\"stock insuffisant\"", threshold = 2, windowMinutes = 5 }));
        Assert.Equal(3, Assert.Single(count).Value);

        // Une alerte par route : seule /api/cart dépasse 500 ms en p90 ; « passe sous » inverse la comparaison.
        var perRoute = Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "http", service, stat = "p90", groupBy = "route", threshold = 500, windowMinutes = 5 }));
        Assert.Equal(["/api/cart", "/api/orders/{id}"], perRoute.Select(e => e.Key).Order());
        Assert.True(perRoute.Single(e => e.Key == "/api/cart").Breach);
        Assert.False(perRoute.Single(e => e.Key == "/api/orders/{id}").Breach);
        var below = Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "http", service, stat = "count", groupBy = "method", comparison = "below", threshold = 15, windowMinutes = 5 }));
        Assert.True(below.Single(e => e.Key == "POST").Breach);
        Assert.False(below.Single(e => e.Key == "GET").Breach);

        // Une part sans condition n'a pas de sens ; mesure inconnue refusée.
        Assert.Equal(HttpStatusCode.BadRequest, (await ui.PostAsJsonAsync("/api/alerts", new { name = "x", kind = "http", stat = "percent" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ui.PostAsJsonAsync("/api/alerts", new { name = "x", kind = "http", stat = "p42" })).StatusCode);
    }

    [Fact]
    public async Task Alert_outside_active_hours_waits_for_the_next_range()
    {
        var service = "svc-hours-" + Guid.NewGuid().ToString("N")[..6];
        var t = DateTime.UtcNow.AddMinutes(-1);
        await SendRequests(service, Enumerable.Range(0, 5).Select(i => Request(i, t.AddMilliseconds(i), "GET", "/", "/", 500, 5)));
        var ui = await server.LoggedInClient();

        // Plage d'activité : tous les jours sauf aujourd'hui (heure de Wolflog = heure du serveur de test).
        var today = (int)DateTime.Now.DayOfWeek;
        var otherDays = Enumerable.Range(0, 7).Where(d => d != today).ToArray();
        var rule = new Dictionary<string, object?>
        {
            ["name"] = "Hors plage " + service, ["kind"] = "http", ["service"] = service, ["stat"] = "errorRate", ["threshold"] = 10,
            ["windowMinutes"] = 5, ["activeDays"] = otherDays, ["activeFrom"] = "8:00", ["activeTo"] = "19:00",
        };
        var created = await Post(ui, "/api/alerts", rule);
        var id = created.GetProperty("id").GetString()!;
        Assert.Equal("08:00", created.GetProperty("activeFrom").GetString());
        await Post(ui, "/api/alerts/run", new { });
        Assert.Equal("pending", State(await Get(ui, "/api/alerts"), id));

        // La plage commence (aujourd'hui coché, toute la journée) : l'alerte se déclenche.
        rule["activeDays"] = null;
        rule["activeFrom"] = null;
        rule["activeTo"] = null;
        (await ui.PutAsJsonAsync($"/api/alerts/{id}", rule)).EnsureSuccessStatusCode();
        await Post(ui, "/api/alerts/run", new { });
        Assert.Equal("firing", State(await Get(ui, "/api/alerts"), id));

        Assert.Equal(HttpStatusCode.BadRequest, (await ui.PostAsJsonAsync("/api/alerts", new { name = "x", kind = "http", activeFrom = "25:00" })).StatusCode);

        static string State(JsonElement list, string id) =>
            list.GetProperty("rules").EnumerateArray().Single(r => r.GetProperty("rule").GetProperty("id").GetString() == id).GetProperty("status").GetString()!;
    }

    [Fact]
    public async Task Frequent_error_alert_counts_occurrences_matching_the_filter()
    {
        var service = "svc-err-" + Guid.NewGuid().ToString("N")[..6];
        var logs = Otlp.Logs(service, 9, DateTime.UtcNow.AddMinutes(-1), i => new LogRecord
        {
            SeverityNumber = SeverityNumber.Error,
            Body = new AnyValue { StringValue = "Échec" },
            Attributes =
            {
                Otlp.Kv("exception.type", i < 6 ? "System.TimeoutException" : "System.InvalidOperationException"),
                Otlp.Kv("exception.message", i < 6 ? "délai dépassé vers la banque" : "état invalide"),
            },
        });
        await Send("/v1/logs", logs.ToByteArray());
        var ui = await server.LoggedInClient();

        var frequent = Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "error", stat = "frequent", service, threshold = 5, windowMinutes = 5 }));
        Assert.Equal(2, frequent.Length);
        Assert.Equal(6, frequent.Single(e => e.Breach).Value);
        Assert.Contains("System.TimeoutException", frequent.Single(e => e.Breach).Message);

        // Filtre : mots du type ou du message ; -mot exclut.
        var filtered = Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "error", stat = "frequent", service, filter = "-banque", threshold = 1, windowMinutes = 5 }));
        Assert.Equal(3, Assert.Single(filtered).Value);
    }

    [Fact]
    public async Task Probe_alerts_on_availability_and_response_time()
    {
        var ui = await server.LoggedInClient();
        var probe = await Post(ui, "/api/probes", new { name = "Port fermé " + Guid.NewGuid().ToString("N")[..6], type = "tcp", target = "127.0.0.1:1", failuresBeforeDown = 1, timeoutSeconds = 3 });
        var id = probe.GetProperty("id").GetString()!;
        await Post(ui, "/api/probes/test", JsonSerializer.Deserialize<Dictionary<string, object>>(probe.GetRawText())!);

        var availability = Assert.Single(Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "probe", targetId = id, stat = "availability", comparison = "below", threshold = 99, windowMinutes = 60 })));
        Assert.True(availability.Breach);
        Assert.Equal(0, availability.Value);
        Assert.Contains("disponibilité 0 %", availability.Message);

        var slow = Assert.Single(Evaluations(await Post(ui, "/api/alerts/preview",
            new { name = "x", kind = "probe", targetId = id, stat = "duration", threshold = 60_000, windowMinutes = 60 })));
        Assert.False(slow.Breach);
        Assert.Contains("temps de réponse", slow.Message);
    }

    [Fact]
    public async Task Probes_with_fixed_times_wait_for_the_next_one()
    {
        var ui = await server.LoggedInClient();
        var at = DateTime.Now.AddHours(2);
        var time = $"{at.Hour:00}:{at.Minute:00}";
        var probe = await Post(ui, "/api/probes", new { name = "Planifiée " + Guid.NewGuid().ToString("N")[..6], type = "tcp", target = "127.0.0.1:1", scheduleTimes = new[] { time }, timeoutSeconds = 3 });
        var id = probe.GetProperty("id").GetString()!;
        Assert.Equal(time, probe.GetProperty("scheduleTimes")[0].GetString());

        // Jamais exécutée à l'enregistrement : la prochaine vérification est l'heure fixe.
        JsonElement entry = default;
        for (var i = 0; i < 50 && entry.ValueKind != JsonValueKind.Object; i++)
        {
            await Task.Delay(100, TestContext.Current.CancellationToken);
            entry = (await Get(ui, "/api/probes?from=1h")).EnumerateArray().Single(x => x.GetProperty("probe").GetProperty("id").GetString() == id);
            if (entry.GetProperty("nextRun").ValueKind != JsonValueKind.String) entry = default;
        }
        var next = entry.GetProperty("nextRun").GetDateTime().ToLocalTime();
        Assert.Equal(new DateTime(at.Year, at.Month, at.Day, at.Hour, at.Minute, 0), next);
        Assert.Equal("unknown", entry.GetProperty("status").GetString());

        Assert.Equal(HttpStatusCode.BadRequest, (await ui.PostAsJsonAsync("/api/probes", new { name = "x", type = "tcp", target = "h:1", scheduleTimes = new[] { "8h" } })).StatusCode);
    }
}
