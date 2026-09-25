using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Google.Protobuf;
using OpenTelemetry.Proto.Collector.Trace.V1;

namespace Vigil.Tests;

/// <summary>Alertes et notifications, sondes, SLO, santé de Vigil, sauvegardes.</summary>
public class MonitoringTests(VigilServerFixture server) : IClassFixture<VigilServerFixture>
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

    /// <summary>Requêtes HTTP entrantes : une sur deux en erreur.</summary>
    private async Task SendRequests(string service, int count)
    {
        var client = server.CreateClient();
        for (var i = 0; i < count; i++)
        {
            var trace = Otlp.Trace(service, Guid.NewGuid().ToString("N"), DateTime.UtcNow.AddSeconds(-30 + i % 20), 1, error: i % 2 == 0);
            using var content = new ByteArrayContent(trace.ToByteArray());
            content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
            using var message = new HttpRequestMessage(HttpMethod.Post, "/v1/traces") { Content = content };
            message.Headers.Add("x-vigil-key", VigilServerFixture.ApiKey);
            (await client.SendAsync(message)).EnsureSuccessStatusCode();
        }
    }

    [Fact]
    public async Task Http_error_rate_alert_fires_notifies_and_resolves()
    {
        var service = "svc-alert-" + Guid.NewGuid().ToString("N")[..6];
        await SendRequests(service, 20);
        var ui = await server.LoggedInClient();

        var channel = await Post(ui, "/api/alert-channels", new { name = "Équipe", type = "teams", target = "https://exemple.webhook.office.com/abc" });
        var channelId = channel.GetProperty("id").GetString()!;

        // Aperçu avant enregistrement : valeur actuelle et déclenchement.
        var rule = new
        {
            name = "Taux d'erreur " + service, kind = "http", stat = "errorRate", service, threshold = 10, windowMinutes = 5,
            channels = new[] { channelId }, runbook = "Vérifier la base de données",
        };
        var preview = await Post(ui, "/api/alerts/preview", rule);
        Assert.True(preview[0].GetProperty("breach").GetBoolean());
        Assert.Equal(50, preview[0].GetProperty("value").GetDouble(), 0.1);

        var created = await Post(ui, "/api/alerts", rule);
        var ruleId = created.GetProperty("id").GetString()!;
        await Post(ui, "/api/alerts/run", new { });

        var active = await Get(ui, "/api/alerts/active");
        var alert = active.GetProperty("items").EnumerateArray().Single(a => a.GetProperty("ruleId").GetString() == ruleId);
        Assert.Equal("firing", alert.GetProperty("status").GetString());
        Assert.Contains("taux d'erreur 50 %", alert.GetProperty("message").GetString());

        // Notification Teams (carte adaptative) envoyée au webhook du canal.
        var sent = server.Notifications.Requests.Where(r => r.Url.Host == "exemple.webhook.office.com").ToList();
        var card = Assert.Single(sent, r => r.Body.Contains(service));
        Assert.Contains("AdaptiveCard", card.Body);
        Assert.Contains("Vérifier la base de données", card.Body);

        // Une seconde évaluation ne renvoie pas de notification (pas de rappel configuré).
        await Post(ui, "/api/alerts/run", new { });
        Assert.Single(server.Notifications.Requests, r => r.Body.Contains(service));

        // Le seuil relevé au-dessus de la valeur : résolution, notifiée.
        var edited = JsonSerializer.Deserialize<Dictionary<string, object>>(created.GetRawText())!;
        edited["threshold"] = 80;
        (await ui.PutAsJsonAsync($"/api/alerts/{ruleId}", edited)).EnsureSuccessStatusCode();
        await Post(ui, "/api/alerts/run", new { });
        Assert.DoesNotContain((await Get(ui, "/api/alerts/active")).GetProperty("items").EnumerateArray(), a => a.GetProperty("ruleId").GetString() == ruleId);
        Assert.Contains(server.Notifications.Requests, r => r.Body.Contains("Résolu") && r.Body.Contains(service));

        var history = await Get(ui, $"/api/alerts/history?from=1h&rule={ruleId}");
        Assert.Equal(["resolved", "firing"], history.EnumerateArray().Select(e => e.GetProperty("status").GetString()).ToArray());

        // Les lecteurs ne voient pas l'URL secrète des webhooks.
        var name = "obs-" + Guid.NewGuid().ToString("N")[..6];
        var temp = (await Post(ui, "/api/admin/users", new { username = name, role = "viewer" })).GetProperty("temporaryPassword").GetString()!;
        var viewer = server.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        (await viewer.PostAsJsonAsync("/api/auth/login", new { username = name, password = temp })).EnsureSuccessStatusCode();
        var channels = await Get(viewer, "/api/alert-channels");
        Assert.DoesNotContain("abc", channels.GetRawText());
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/alerts", rule)).StatusCode);
    }

    [Fact]
    public async Task Probes_report_failures_and_slos_track_error_budget()
    {
        var ui = await server.LoggedInClient();

        // Sonde vers un port fermé : échec immédiat, sans rien enregistrer tant qu'elle n'est pas créée.
        var test = await Post(ui, "/api/probes/test", new { name = "Fermé", type = "http", target = "http://127.0.0.1:1/", timeoutSeconds = 3 });
        Assert.False(test.GetProperty("ok").GetBoolean());
        Assert.False(string.IsNullOrEmpty(test.GetProperty("error").GetString()));
        Assert.Equal(HttpStatusCode.BadRequest, (await ui.PostAsJsonAsync("/api/probes", new { name = "x", type = "http", target = "pas une url" })).StatusCode);

        var probe = await Post(ui, "/api/probes", new { name = "Port fermé", type = "tcp", target = "127.0.0.1:1", failuresBeforeDown = 1, timeoutSeconds = 3 });
        var probeId = probe.GetProperty("id").GetString()!;
        await Post(ui, "/api/probes/test", JsonSerializer.Deserialize<Dictionary<string, object>>(probe.GetRawText())!);
        var probes = await Get(ui, "/api/probes?from=1h");
        var p = probes.EnumerateArray().Single(x => x.GetProperty("probe").GetProperty("id").GetString() == probeId);
        Assert.Equal("down", p.GetProperty("status").GetString());

        // Les résultats sont des métriques : disponibilité calculée à partir d'elles.
        probes = await Get(ui, "/api/probes?from=1h");
        p = probes.EnumerateArray().Single(x => x.GetProperty("probe").GetProperty("id").GetString() == probeId);
        Assert.Equal(0, p.GetProperty("stats").GetProperty("uptime").GetDouble());

        // SLO de disponibilité sur un service dont la moitié des requêtes échoue : objectif non tenu.
        var service = "svc-slo-" + Guid.NewGuid().ToString("N")[..6];
        await SendRequests(service, 10);
        var slo = await Post(ui, "/api/slos", new { name = "Disponibilité " + service, service, targetPercent = 99, windowDays = 7 });
        var detail = await Get(ui, $"/api/slos/{slo.GetProperty("id").GetString()}");
        var status = detail.GetProperty("status");
        Assert.Equal(10, status.GetProperty("total").GetInt64());
        Assert.Equal(5, status.GetProperty("bad").GetInt64());
        Assert.Equal("breached", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("budgetRemaining").GetDouble() < 0);
        Assert.True(detail.GetProperty("history").GetArrayLength() > 0);
    }

    [Fact]
    public async Task Health_and_backup_restore_of_configuration()
    {
        var ui = await server.LoggedInClient();
        var health = await Get(ui, "/api/health/vigil");
        Assert.Contains(health.GetProperty("checks").EnumerateArray(), c => c.GetProperty("id").GetString() == "disk");

        var dash = await Post(ui, "/api/dashboards", new { name = "À sauvegarder", panels = Array.Empty<object>() });
        var id = dash.GetProperty("id").GetString()!;

        var backup = await ui.GetAsync("/api/admin/backup");
        backup.EnsureSuccessStatusCode();
        Assert.Equal("application/zip", backup.Content.Headers.ContentType?.MediaType);
        var bytes = await backup.Content.ReadAsByteArrayAsync();
        using (var zip = new ZipArchive(new MemoryStream(bytes)))
        {
            Assert.Contains(zip.Entries, e => e.FullName == "config/users.json");
            Assert.Contains(zip.Entries, e => e.FullName == "config/dashboards.json");
            Assert.DoesNotContain(zip.Entries, e => e.FullName.StartsWith("data/"));
        }

        (await ui.DeleteAsync($"/api/dashboards/{id}")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await ui.GetAsync($"/api/dashboards/{id}")).StatusCode);

        using var form = new MultipartFormDataContent { { new ByteArrayContent(bytes), "file", "sauvegarde.zip" } };
        (await ui.PostAsync("/api/admin/restore", form)).EnsureSuccessStatusCode();
        Assert.Equal("À sauvegarder", (await Get(ui, $"/api/dashboards/{id}")).GetProperty("name").GetString());

        // La sauvegarde est notée dans la santé de Vigil.
        health = await Get(ui, "/api/health/vigil");
        var check = health.GetProperty("checks").EnumerateArray().Single(c => c.GetProperty("id").GetString() == "backup");
        Assert.StartsWith("Dernière sauvegarde", check.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Metric_exemplars_link_to_traces()
    {
        var service = "svc-ex-" + Guid.NewGuid().ToString("N")[..6];
        var now = DateTime.UtcNow.AddSeconds(-5);
        var point = new OpenTelemetry.Proto.Metrics.V1.HistogramDataPoint
        {
            TimeUnixNano = Otlp.Nanos(now), Count = 2, Sum = 1.3, ExplicitBounds = { 0.5, 1 }, BucketCounts = { 1, 0, 1 },
        };
        foreach (var (value, trace) in new[] { (0.1, "0102030405060708090a0b0c0d0e0f10"), (1.2, "1112131415161718191a1b1c1d1e1f20") })
            point.Exemplars.Add(new OpenTelemetry.Proto.Metrics.V1.Exemplar
            {
                TimeUnixNano = Otlp.Nanos(now), AsDouble = value,
                TraceId = ByteString.CopyFrom(Convert.FromHexString(trace)), SpanId = ByteString.CopyFrom(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }),
            });
        var request = new OpenTelemetry.Proto.Collector.Metrics.V1.ExportMetricsServiceRequest
        {
            ResourceMetrics =
            {
                new OpenTelemetry.Proto.Metrics.V1.ResourceMetrics
                {
                    Resource = Otlp.Resource(service),
                    ScopeMetrics = { new OpenTelemetry.Proto.Metrics.V1.ScopeMetrics { Metrics = { new OpenTelemetry.Proto.Metrics.V1.Metric
                    {
                        Name = "http.server.request.duration", Unit = "s",
                        Histogram = new OpenTelemetry.Proto.Metrics.V1.Histogram { DataPoints = { point }, AggregationTemporality = OpenTelemetry.Proto.Metrics.V1.AggregationTemporality.Delta },
                    } } } },
                },
            },
        };
        using var content = new ByteArrayContent(request.ToByteArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        using var message = new HttpRequestMessage(HttpMethod.Post, "/v1/metrics") { Content = content };
        message.Headers.Add("x-vigil-key", VigilServerFixture.ApiKey);
        (await server.CreateClient().SendAsync(message)).EnsureSuccessStatusCode();

        var ui = await server.LoggedInClient();
        JsonElement list = default;
        for (var i = 0; i < 50; i++)
        {
            list = await Get(ui, $"/api/metrics/exemplars?from=1h&name=http.server.request.duration&service={service}");
            if (list.GetArrayLength() == 2) break;
            await Task.Delay(100);
        }
        Assert.Equal(2, list.GetArrayLength());
        // Les plus grandes valeurs d'abord : la requête la plus lente mène à sa trace.
        Assert.Equal("1112131415161718191a1b1c1d1e1f20", list[0].GetProperty("traceId").GetString());
        Assert.Equal(1.2, list[0].GetProperty("value").GetDouble(), 3);
        Assert.Equal("0102030405060708", list[0].GetProperty("spanId").GetString());

        // Toujours lisibles après écriture en Parquet et compaction.
        (await ui.PostAsync("/api/system/compact", null)).EnsureSuccessStatusCode();
        list = await Get(ui, $"/api/metrics/exemplars?from=1h&name=http.server.request.duration&service={service}");
        Assert.Equal(2, list.GetArrayLength());
    }
}
