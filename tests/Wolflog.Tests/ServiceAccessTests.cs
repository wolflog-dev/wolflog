using System.Net.Http.Headers;
using Microsoft.AspNetCore.Mvc.Testing;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Metrics.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Metrics.V1;
using OpenTelemetry.Proto.Resource.V1;
using OpenTelemetry.Proto.Trace.V1;

namespace Wolflog.Tests;

/// <summary>
/// Services visibles par profil d'accès ou par compte : chaque famille de l'API ne renvoie que les données, et n'accepte que
/// les écritures, des services visibles (« boutique-* » ici, « compta » restant caché).
/// </summary>
public class ServiceAccessTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const string Chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
    private static readonly Lock SeedLock = new();
    private static Task<Seeded>? SeedTask;

    /// <summary>Données de départ : trois services, dont « compta » dans son propre environnement.</summary>
    private sealed record Seeded(string TraceWeb, string TraceCompta, string TraceMixed, string ErrorWeb, string ErrorCompta, string ProbeCompta, string SloCompta);

    private Task<Seeded> Seed()
    {
        lock (SeedLock) return SeedTask ??= SeedAsync();
    }

    private async Task<Seeded> SeedAsync()
    {
        var now = DateTime.UtcNow.AddMinutes(-2);
        foreach (var (service, env) in new[] { ("boutique-web", "test"), ("boutique-api", "test"), ("compta", "compta-prod") })
        {
            var scope = new ScopeLogs();
            for (var i = 0; i < 4; i++)
            {
                var record = new LogRecord
                {
                    TimeUnixNano = Otlp.Nanos(now.AddMilliseconds(i)),
                    SeverityNumber = i == 0 ? SeverityNumber.Error : SeverityNumber.Info,
                    Body = new AnyValue { StringValue = i == 0 ? "Échec du traitement" : $"Bonjour de {service} n°{i}" },
                };
                if (i == 0)
                {
                    record.Attributes.Add(Otlp.Kv("exception.type", $"Shop.{service.Replace("-", "")}Exception"));
                    record.Attributes.Add(Otlp.Kv("exception.message", "boom"));
                    record.Attributes.Add(Otlp.Kv("exception.stacktrace", $"Shop.{service}Exception: boom\n   at Shop.Run() in Run.cs:line 3"));
                }
                scope.LogRecords.Add(record);
            }
            await Send("/v1/logs", new ExportLogsServiceRequest { ResourceLogs = { new ResourceLogs { Resource = Resource(service, env), ScopeLogs = { scope } } } });

            var metric = new Metric
            {
                Name = service == "compta" ? "factures.en_attente" : "panier.taille",
                Gauge = new Gauge { DataPoints = { new NumberDataPoint { TimeUnixNano = Otlp.Nanos(now), AsDouble = 3 } } },
            };
            await Send("/v1/metrics", new ExportMetricsServiceRequest
            {
                ResourceMetrics = { new ResourceMetrics { Resource = Resource(service, env), ScopeMetrics = { new ScopeMetrics { Metrics = { metric } } } } },
            });
        }

        // Traces : une par service, et un appel de boutique-web vers compta (même trace, deux services).
        var traceWeb = NewTraceId();
        var traceCompta = NewTraceId();
        var traceMixed = NewTraceId();
        await Send("/v1/traces", Retag(Otlp.Trace("boutique-web", traceWeb, now, 2), "test"));
        await Send("/v1/traces", Retag(Otlp.Trace("compta", traceCompta, now, 2), "compta-prod"));
        var call = new Span
        {
            TraceId = ByteString.CopyFrom(Convert.FromHexString(traceMixed)), SpanId = ByteString.CopyFrom([1, 1, 1, 1, 1, 1, 1, 1]),
            Name = "POST compta", Kind = Span.Types.SpanKind.Client,
            StartTimeUnixNano = Otlp.Nanos(now), EndTimeUnixNano = Otlp.Nanos(now.AddMilliseconds(30)),
            Attributes = { Otlp.Kv("server.address", "compta.interne"), Otlp.Kv("http.request.method", "POST") },
        };
        var served = new Span
        {
            TraceId = call.TraceId, SpanId = ByteString.CopyFrom([2, 2, 2, 2, 2, 2, 2, 2]), ParentSpanId = call.SpanId,
            Name = "POST /factures", Kind = Span.Types.SpanKind.Server,
            StartTimeUnixNano = Otlp.Nanos(now.AddMilliseconds(5)), EndTimeUnixNano = Otlp.Nanos(now.AddMilliseconds(25)),
        };
        await Send("/v1/traces", new ExportTraceServiceRequest
        {
            ResourceSpans =
            {
                new ResourceSpans { Resource = Resource("boutique-web", "test"), ScopeSpans = { new ScopeSpans { Spans = { call } } } },
                new ResourceSpans { Resource = Resource("compta", "compta-prod"), ScopeSpans = { new ScopeSpans { Spans = { served } } } },
            },
        });

        // Audience (une visite par site) et déploiements déclarés par la CI.
        foreach (var site in new[] { "boutique-web", "compta" })
        {
            await SendJson("/v1/analytics", new { service = site, events = new[] { new { type = "pageview", path = "/", ip = "198.51.100.7", userAgent = Chrome } } });
            await SendJson("/v1/deployments", new { service = site == "compta" ? "compta" : "boutique-api", version = "2.0.0", env = "test" });
        }

        var admin = await server.LoggedInClient();
        await Eventually(() => Get(admin, "/api/services?from=1h"), s => s.GetArrayLength() == 3 && s.EnumerateArray().All(x => x.GetProperty("spans").GetInt64() > 0));
        await Eventually(() => Get(admin, "/api/metrics?from=1h"), m => m.GetArrayLength() >= 2);
        await Eventually(() => Get(admin, "/api/analytics/summary?from=1h&service=compta"), s => s.GetProperty("current").GetProperty("pageviews").GetInt64() > 0);
        var errors = (await Eventually(() => Get(admin, "/api/errors?from=1h"), e => e.GetProperty("items").GetArrayLength() == 3))
            .GetProperty("items").EnumerateArray().ToList();
        string Fingerprint(string service) => errors.Single(e => e.GetProperty("service").GetString() == service).GetProperty("fingerprint").GetString()!;

        // Sondes, objectif et règles d'alerte : de compta, de la boutique, et globales.
        var probeCompta = await Send(admin, HttpMethod.Post, "/api/probes", new { name = "Compta", type = "http", target = "http://127.0.0.1:9/", service = "compta", enabled = false });
        await Send(admin, HttpMethod.Post, "/api/probes", new { name = "Boutique", type = "http", target = "http://127.0.0.1:9/", service = "boutique-web", enabled = false });
        await Send(admin, HttpMethod.Post, "/api/probes", new { name = "Site public", type = "http", target = "http://127.0.0.1:9/", enabled = false });
        var sloCompta = await Send(admin, HttpMethod.Post, "/api/slos", new { name = "Compta disponible", source = "http", service = "compta", targetPercent = 99 });
        await Send(admin, HttpMethod.Post, "/api/slos", new { name = "Boutique disponible", source = "http", service = "boutique-web", targetPercent = 99 });
        foreach (var rule in new object[]
                 {
                     new { name = "Compta lente", kind = "http", service = "compta", stat = "p95", threshold = 1000 },
                     new { name = "Boutique lente", kind = "http", service = "boutique-web", stat = "p95", threshold = 1000 },
                     new { name = "Erreurs par service", kind = "http", perService = true, threshold = 50 },
                     new { name = "Erreurs, tous services", kind = "http", threshold = 50 },
                     new { name = "Santé de Wolflog", kind = "health" },
                 })
            await Send(admin, HttpMethod.Post, "/api/alerts", rule);

        return new Seeded(traceWeb, traceCompta, traceMixed, Fingerprint("boutique-web"), Fingerprint("compta"),
            probeCompta.GetProperty("id").GetString()!, sloCompta.GetProperty("id").GetString()!);
    }

    // ---------------------------------------------------------------------- outils

    private static Resource Resource(string service, string env) => new()
    {
        Attributes = { Otlp.Kv("service.name", service), Otlp.Kv("host.name", "test-host"), Otlp.Kv("deployment.environment.name", env) },
    };

    private static ExportTraceServiceRequest Retag(ExportTraceServiceRequest request, string env)
    {
        foreach (var rs in request.ResourceSpans) rs.Resource = Resource(rs.Resource.Attributes.First(a => a.Key == "service.name").Value.StringValue, env);
        return request;
    }

    private static string NewTraceId() => Guid.NewGuid().ToString("N");

    private async Task Send(string path, IMessage request)
    {
        using var content = new ByteArrayContent(request.ToByteArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        using var message = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };
        message.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
        (await server.CreateClient().SendAsync(message)).EnsureSuccessStatusCode();
    }

    private async Task SendJson(string path, object body)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body, options: Json) };
        message.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
        (await server.CreateClient().SendAsync(message)).EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        Assert.True(response.IsSuccessStatusCode, $"{url} : {(int)response.StatusCode}");
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static async Task<JsonElement> Send(HttpClient client, HttpMethod method, string url, object body)
    {
        var response = await client.SendAsync(new HttpRequestMessage(method, url) { Content = JsonContent.Create(body) });
        Assert.True(response.IsSuccessStatusCode, $"{method} {url} : {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var text = await response.Content.ReadAsStringAsync();
        return string.IsNullOrEmpty(text) ? default : JsonSerializer.Deserialize<JsonElement>(text, Json);
    }

    private static async Task<T> Eventually<T>(Func<Task<T>> probe, Func<T, bool> ok, int seconds = 20)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (true)
        {
            var value = await probe();
            if (ok(value) || DateTime.UtcNow > until) return value;
            await Task.Delay(100);
        }
    }

    private static string[] Names(JsonElement array, string property) =>
        array.EnumerateArray().Select(e => e.GetProperty(property).GetString()!).ToArray();

    private static bool Boutique(string? service) => service?.StartsWith("boutique-", StringComparison.Ordinal) == true;

    /// <summary>Profil « Boutique » (toutes les parties, services boutique-* écrits en casse libre) ; compte éditeur connecté.</summary>
    private async Task<HttpClient> BoutiqueEditor(HttpClient admin)
    {
        var suffix = Guid.NewGuid().ToString("N")[..6];
        var profile = await Send(admin, HttpMethod.Post, "/api/admin/access-profiles", new
        {
            name = "Boutique " + suffix, sections = new[]
            {
                "overview", "dashboards", "logs", "requests", "traces", "errors", "metrics", "map", "profiles", "audience", "clickmaps", "alerts", "uptime", "slos",
            },
            services = new[] { "Boutique-*" },
        });
        return await NewUser(admin, "editor", profile.GetProperty("id").GetString(), null);
    }

    private async Task<HttpClient> NewUser(HttpClient admin, string role, string? profileId, string[]? services)
    {
        var username = "svc-" + Guid.NewGuid().ToString("N")[..8];
        var created = await Send(admin, HttpMethod.Post, "/api/admin/users", new { username, role, profileId, services });
        var client = server.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        (await client.PostAsJsonAsync("/api/auth/login", new { username, password = created.GetProperty("temporaryPassword").GetString() })).EnsureSuccessStatusCode();
        return client;
    }

    // ---------------------------------------------------------------------- tests

    [Fact]
    public async Task Data_queries_only_return_visible_services()
    {
        var seed = await Seed();
        var admin = await server.LoggedInClient();
        var user = await BoutiqueEditor(admin);

        Assert.Equal(new[] { "Boutique-*" }, (await Get(user, "/api/auth/me")).GetProperty("services").EnumerateArray().Select(s => s.GetString()));
        Assert.Equal(new[] { "boutique-api", "boutique-web" }, Names(await Get(user, "/api/services?from=1h"), "name"));
        Assert.Contains("compta", Names(await Get(admin, "/api/services?from=1h"), "name"));

        // Logs : recherche, histogramme, export ; un filtre sur un service caché ne renvoie rien.
        var expected = (await Get(admin, "/api/logs?from=1h&limit=1000")).GetProperty("items").EnumerateArray().Count(l => Boutique(l.GetProperty("service").GetString()));
        var logs = (await Get(user, "/api/logs?from=1h&limit=1000")).GetProperty("items");
        Assert.True(expected >= 8, $"{expected} logs de la boutique");
        Assert.Equal(expected, logs.GetArrayLength());
        Assert.All(logs.EnumerateArray(), l => Assert.True(Boutique(l.GetProperty("service").GetString())));
        Assert.Equal(0, (await Get(user, "/api/logs?from=1h&service=compta")).GetProperty("items").GetArrayLength());
        var histogram = (await Get(user, "/api/logs/histogram?from=1h")).GetProperty("buckets").EnumerateArray()
            .Sum(b => new[] { "trace", "debug", "info", "warn", "error", "fatal" }.Sum(l => b.GetProperty(l).GetInt64()));
        Assert.Equal(expected, histogram);
        var exported = await Get(user, "/api/logs/export?from=1h&format=json");
        Assert.Equal(expected, exported.GetArrayLength());

        // Requêtes HTTP (liste, synthèse, export) et traces.
        Assert.All((await Get(user, "/api/requests?from=1h")).EnumerateArray(), r => Assert.True(Boutique(r.GetProperty("service").GetString())));
        Assert.All((await Get(user, "/api/requests/export?from=1h&format=json")).EnumerateArray(), r => Assert.True(Boutique(r.GetProperty("service").GetString())));
        Assert.True((await Get(user, "/api/requests/summary?from=1h")).GetProperty("count").GetInt64()
                    < (await Get(admin, "/api/requests/summary?from=1h")).GetProperty("count").GetInt64());
        var traces = Names(await Get(user, "/api/traces?from=1h"), "traceId");
        Assert.Contains(seed.TraceWeb, traces);
        Assert.Contains(seed.TraceMixed, traces);
        Assert.DoesNotContain(seed.TraceCompta, traces);

        // Détail d'une trace : seulement les spans (et logs) des services visibles ; aucun : introuvable.
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync($"/api/traces/{seed.TraceCompta}")).StatusCode);
        var mixed = await Get(user, $"/api/traces/{seed.TraceMixed}");
        Assert.Equal(new[] { "boutique-web" }, Names(mixed.GetProperty("spans"), "service"));
        Assert.Equal(2, (await Get(admin, $"/api/traces/{seed.TraceMixed}")).GetProperty("spans").GetArrayLength());

        // Erreurs : liste et détail.
        Assert.All((await Get(user, "/api/errors?from=1h")).GetProperty("items").EnumerateArray(), e => Assert.True(Boutique(e.GetProperty("service").GetString())));
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync($"/api/errors/{seed.ErrorCompta}?from=1h")).StatusCode);
        (await user.GetAsync($"/api/errors/{seed.ErrorWeb}?from=1h")).EnsureSuccessStatusCode();

        // Métriques : noms et séries.
        var metrics = Names(await Get(user, "/api/metrics?from=1h"), "name");
        Assert.Contains("panier.taille", metrics);
        Assert.DoesNotContain("factures.en_attente", metrics);
        Assert.Equal(0, (await Get(user, "/api/metrics/series?from=1h&name=factures.en_attente")).GetProperty("series").GetArrayLength());

        // Requêtes personnalisées et valeurs d'un champ.
        var groups = (await Get(user, "/api/query?from=1h&source=logs&agg=count&groupBy=service&view=top")).GetProperty("rows");
        Assert.All(groups.EnumerateArray(), g => Assert.True(Boutique(g.GetProperty("group").GetString())));
        Assert.All((await Get(user, "/api/fields/values?from=1h&source=spans&key=service")).EnumerateArray(), v => Assert.True(Boutique(v.GetProperty("value").GetString())));

        // Environnements (seulement ceux des services visibles), déploiements, vue d'ensemble, audience.
        Assert.DoesNotContain("compta-prod", (await Get(user, "/api/environments")).EnumerateArray().Select(e => e.GetString()));
        Assert.Contains("compta-prod", (await Get(admin, "/api/environments")).EnumerateArray().Select(e => e.GetString()));
        Assert.DoesNotContain("compta-prod", Names(await Get(user, "/api/environments/stats"), "name"));
        var deployments = Names(await Get(user, "/api/deployments?from=1h"), "service");
        Assert.Contains("boutique-api", deployments);
        Assert.DoesNotContain("compta", deployments);
        Assert.All((await Get(user, "/api/overview?from=1h")).GetProperty("services").EnumerateArray(), s => Assert.True(Boutique(s.GetProperty("name").GetString())));
        Assert.Equal(0, (await Get(user, "/api/analytics/summary?from=1h&service=compta")).GetProperty("current").GetProperty("pageviews").GetInt64());
        Assert.True((await Get(user, "/api/analytics/summary?from=1h&service=boutique-web")).GetProperty("current").GetProperty("pageviews").GetInt64() > 0);
    }

    [Fact]
    public async Task Service_map_keeps_calls_to_hidden_services_as_external_dependencies()
    {
        await Seed();
        var admin = await server.LoggedInClient();
        var user = await BoutiqueEditor(admin);

        var full = await Get(admin, "/api/service-map?from=1h");
        Assert.Contains(full.GetProperty("edges").EnumerateArray(), e => e.GetProperty("source").GetString() == "boutique-web" && e.GetProperty("target").GetString() == "compta");

        // Compte limité : pas de nœud « compta » ; l'appel sortant de boutique-web reste, vers l'hôte qu'il a appelé.
        var map = await Get(user, "/api/service-map?from=1h");
        Assert.DoesNotContain("compta", Names(map.GetProperty("nodes"), "id"));
        Assert.DoesNotContain(map.GetProperty("edges").EnumerateArray(), e => e.GetProperty("target").GetString() == "compta" || e.GetProperty("source").GetString() == "compta");
        var external = Assert.Single(map.GetProperty("edges").EnumerateArray(), e => e.GetProperty("source").GetString() == "boutique-web");
        Assert.Equal("external:compta.interne", external.GetProperty("target").GetString());
    }

    [Fact]
    public async Task Writes_are_limited_to_visible_services()
    {
        var seed = await Seed();
        var admin = await server.LoggedInClient();
        var user = await BoutiqueEditor(admin);

        // Erreurs : statut seulement pour une erreur vue dans un service visible.
        Assert.Equal(HttpStatusCode.NotFound, (await user.PostAsJsonAsync($"/api/errors/{seed.ErrorCompta}/state", new { status = "resolved" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await user.PostAsJsonAsync("/api/errors/state", new { fingerprints = new[] { seed.ErrorWeb, seed.ErrorCompta }, status = "ignored" })).StatusCode);
        (await user.PostAsJsonAsync($"/api/errors/{seed.ErrorWeb}/state", new { status = "resolved" })).EnsureSuccessStatusCode();

        // Déploiements, profilage.
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/deployments", new { service = "compta", version = "9" })).StatusCode);
        (await user.PostAsJsonAsync("/api/deployments", new { service = "boutique-web", version = "9" })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/profiles", new { service = "compta", kind = "cpu", seconds = 5 })).StatusCode);
        var requested = await Send(user, HttpMethod.Post, "/api/profiles", new { service = "boutique-web", kind = "cpu", seconds = 5 });
        await Send(admin, HttpMethod.Post, "/api/profiles", new { service = "compta", kind = "cpu", seconds = 5 });
        var profiles = Names(await Get(user, "/api/profiles"), "service");
        Assert.Contains("boutique-web", profiles);
        Assert.DoesNotContain("compta", profiles);
        Assert.Contains("compta", Names(await Get(admin, "/api/profiles"), "service"));
        Assert.Equal("boutique-web", requested.GetProperty("service").GetString());

        // Alertes, sondes, objectifs : seulement sur un service visible.
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/alerts", new { name = "x", kind = "http", service = "compta" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/alerts", new { name = "x", kind = "http" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/alerts/preview", new { name = "x", kind = "http", perService = true })).StatusCode);
        await Send(user, HttpMethod.Post, "/api/alerts", new { name = "API boutique lente", kind = "http", service = "boutique-api", stat = "p95", threshold = 2000 });
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/probes", new { name = "x", type = "http", target = "http://127.0.0.1:9/" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync($"/api/probes/{seed.ProbeCompta}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/slos", new { name = "x", source = "http", service = "compta", targetPercent = 99 })).StatusCode);
    }

    [Fact]
    public async Task Alerts_probes_and_slos_follow_visible_services()
    {
        var seed = await Seed();
        var admin = await server.LoggedInClient();
        var user = await BoutiqueEditor(admin);

        // Règles : celles de la boutique, les règles globales par élément, la santé de Wolflog ; jamais compta ni un total global.
        var rules = (await Get(user, "/api/alerts")).GetProperty("rules").EnumerateArray().Select(r => r.GetProperty("rule").GetProperty("name").GetString()).ToList();
        Assert.Contains("Boutique lente", rules);
        Assert.Contains("Erreurs par service", rules);
        Assert.Contains("Santé de Wolflog", rules);
        Assert.DoesNotContain("Compta lente", rules);
        Assert.DoesNotContain("Erreurs, tous services", rules);
        Assert.Equal(5, (await Get(admin, "/api/alerts")).GetProperty("rules").EnumerateArray().Count(r => r.GetProperty("rule").GetProperty("createdBy").GetString() == "admin"));

        // Sondes : sans service (communes) et de la boutique ; objectifs : de la boutique.
        var probes = (await Get(user, "/api/probes?from=1h")).EnumerateArray().Select(p => p.GetProperty("probe").GetProperty("name").GetString()).ToList();
        Assert.Contains("Site public", probes);
        Assert.Contains("Boutique", probes);
        Assert.DoesNotContain("Compta", probes);
        var slos = (await Get(user, "/api/slos")).EnumerateArray().Select(s => s.GetProperty("slo").GetProperty("name").GetString()).ToList();
        Assert.Equal(new[] { "Boutique disponible" }, slos);
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync($"/api/slos/{seed.SloCompta}")).StatusCode);
        (await admin.GetAsync($"/api/slos/{seed.SloCompta}")).EnsureSuccessStatusCode();
        (await user.GetAsync("/api/alerts/active")).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task User_override_and_admin_bypass()
    {
        var seed = await Seed();
        var admin = await server.LoggedInClient();

        // Sans profil (tout voir), mais limité à compta par son compte.
        var accountant = await NewUser(admin, "viewer", null, ["compta"]);
        var me = await Get(accountant, "/api/auth/me");
        Assert.Equal(new[] { "compta" }, me.GetProperty("services").EnumerateArray().Select(s => s.GetString()));
        Assert.Equal(14, me.GetProperty("sections").GetArrayLength());
        Assert.Equal(new[] { "compta" }, Names(await Get(accountant, "/api/services?from=1h"), "name"));
        (await accountant.GetAsync($"/api/traces/{seed.TraceCompta}")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await accountant.GetAsync($"/api/traces/{seed.TraceWeb}")).StatusCode);
        // Grafana (lectures sans filtre) : refusé à un compte limité.
        Assert.Equal(HttpStatusCode.Forbidden, (await accountant.GetAsync("/api/grafana/logs?from=1h")).StatusCode);

        // Motif exact plutôt que joker ; liste vide = tous ; retour aux services du profil.
        var users = await Get(admin, "/api/admin/users");
        var id = users.EnumerateArray().Single(u => u.GetProperty("services").ValueKind == JsonValueKind.Array
            && u.GetProperty("services").EnumerateArray().Any(s => s.GetString() == "compta")).GetProperty("id").GetString();
        await Send(admin, HttpMethod.Put, $"/api/admin/users/{id}", new { services = new[] { "boutique-api" } });
        Assert.Equal(new[] { "boutique-api" }, Names(await Get(accountant, "/api/services?from=1h"), "name"));
        await Send(admin, HttpMethod.Put, $"/api/admin/users/{id}", new { inheritServices = true });
        Assert.Equal(JsonValueKind.Null, (await Get(accountant, "/api/auth/me")).GetProperty("services").ValueKind);
        Assert.Equal(3, (await Get(accountant, "/api/services?from=1h")).GetArrayLength());

        // Administrateur : tout, même avec une liste de services sur son compte.
        Assert.Equal(JsonValueKind.Null, (await Get(admin, "/api/auth/me")).GetProperty("services").ValueKind);
        var bossClient = await NewUser(admin, "admin", null, ["compta"]);
        Assert.Equal(3, (await Get(bossClient, "/api/services?from=1h")).GetArrayLength());

        // Validation des listes.
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/admin/access-profiles",
            new { name = "Étoile " + Guid.NewGuid().ToString("N")[..4], sections = new[] { "logs" }, services = new[] { "*" } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync($"/api/admin/users/{id}", new { services = new[] { new string('x', 300) } })).StatusCode);
    }

    [Fact]
    public async Task Live_tail_skips_hidden_services()
    {
        await Seed();
        var admin = await server.LoggedInClient();
        var user = await BoutiqueEditor(admin);

        using var response = await user.GetAsync("/api/logs/tail", HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);
        Assert.Equal(": connected", await reader.ReadLineAsync());

        var marker = Guid.NewGuid().ToString("N")[..8];
        foreach (var service in new[] { "compta", "boutique-web" })
            await Send("/v1/logs", Otlp.Logs(service, 1, make: _ => new LogRecord { SeverityNumber = SeverityNumber.Info, Body = new AnyValue { StringValue = $"direct {marker} {service}" } }));

        // Lignes reçues jusqu'au log de la boutique : celui de compta n'est jamais passé.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var received = new List<string>();
        while (!received.Any(l => l.Contains($"{marker} boutique-web")))
        {
            var line = await reader.ReadLineAsync(timeout.Token);
            if (line is null) break;
            if (line.StartsWith("data:", StringComparison.Ordinal)) received.Add(line);
        }
        Assert.Contains(received, l => l.Contains($"{marker} boutique-web"));
        Assert.DoesNotContain(received, l => l.Contains($"{marker} compta"));
    }
}
