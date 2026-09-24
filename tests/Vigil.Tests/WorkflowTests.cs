using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Google.Protobuf;
using Microsoft.AspNetCore.Mvc.Testing;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Logs.V1;

namespace Vigil.Tests;

/// <summary>Comptes, rôles, clés API, statut des erreurs, déploiements, recherches enregistrées, export.</summary>
public class WorkflowTests(VigilServerFixture server) : IClassFixture<VigilServerFixture>
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
        response.EnsureSuccessStatusCode();
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

    private async Task<HttpClient> Login(string username, string password)
    {
        var client = server.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        (await client.PostAsJsonAsync("/api/auth/login", new { username, password })).EnsureSuccessStatusCode();
        return client;
    }

    private async Task<HttpResponseMessage> SendLogs(ExportLogsServiceRequest request, string key)
    {
        var client = server.CreateClient();
        using var content = new ByteArrayContent(request.ToByteArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        using var message = new HttpRequestMessage(HttpMethod.Post, "/v1/logs") { Content = content };
        message.Headers.Add("x-vigil-key", key);
        return await client.SendAsync(message);
    }

    private static ExportLogsServiceRequest Exception(string service, string version, string type, DateTime at)
    {
        var request = Otlp.Logs(service, 1, at, _ => new LogRecord
        {
            SeverityNumber = SeverityNumber.Error,
            Body = new OpenTelemetry.Proto.Common.V1.AnyValue { StringValue = "Échec du traitement" },
            Attributes =
            {
                Otlp.Kv("exception.type", type),
                Otlp.Kv("exception.message", "boom"),
                Otlp.Kv("exception.stacktrace", $"{type}: boom\n   at Shop.Orders.Process() in Orders.cs:line 12"),
            },
        });
        request.ResourceLogs[0].Resource.Attributes.Add(Otlp.Kv("service.version", version));
        return request;
    }

    [Fact]
    public async Task Roles_limit_what_each_user_can_do()
    {
        var admin = await server.LoggedInClient();
        var name = "lecteur-" + Guid.NewGuid().ToString("N")[..6];
        var created = await Post(admin, "/api/admin/users", new { username = name, role = "viewer" });
        var userId = created.GetProperty("user").GetProperty("id").GetString()!;
        var temporary = created.GetProperty("temporaryPassword").GetString()!;

        var viewer = await Login(name, temporary);
        var me = await Get(viewer, "/api/auth/me");
        Assert.Equal("viewer", me.GetProperty("role").GetString());
        Assert.True(me.GetProperty("mustChangePassword").GetBoolean());

        // Lecture autorisée, modification et administration refusées.
        (await viewer.GetAsync("/api/dashboards")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/dashboards", new { name = "x", panels = Array.Empty<object>() })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.GetAsync("/api/admin/users")).StatusCode);

        // Changement du mot de passe provisoire.
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsJsonAsync("/api/account/password", new { current = "faux", next = "nouveau-mot-de-passe" })).StatusCode);
        await Post(viewer, "/api/account/password", new { current = temporary, next = "nouveau-mot-de-passe" });
        Assert.False((await Get(viewer, "/api/auth/me")).GetProperty("mustChangePassword").GetBoolean());

        // Promotion : prise en compte sans se reconnecter.
        (await admin.PutAsJsonAsync($"/api/admin/users/{userId}", new { role = "editor" })).EnsureSuccessStatusCode();
        var dash = await viewer.PostAsJsonAsync("/api/dashboards", new { name = "Tableau d'un éditeur", panels = Array.Empty<object>() });
        dash.EnsureSuccessStatusCode();

        // Désactivation : la session tombe immédiatement.
        (await admin.PutAsJsonAsync($"/api/admin/users/{userId}", new { disabled = true })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.GetAsync("/api/dashboards")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.CreateClient().PostAsJsonAsync("/api/auth/login", new { username = name, password = "nouveau-mot-de-passe" })).StatusCode);

        // Garde-fous : pas de suppression de soi-même ni du dernier administrateur.
        var users = await Get(admin, "/api/admin/users");
        var adminId = users.EnumerateArray().First(u => u.GetProperty("username").GetString() == "admin").GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.DeleteAsync($"/api/admin/users/{adminId}")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync($"/api/admin/users/{adminId}", new { role = "viewer" })).StatusCode);

        (await admin.DeleteAsync($"/api/admin/users/{userId}")).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Api_keys_can_be_created_used_and_revoked()
    {
        var admin = await server.LoggedInClient();
        var created = await Post(admin, "/api/admin/keys", new { name = "api-commandes", kind = "server" });
        var key = created.GetProperty("key").GetString()!;
        var id = created.GetProperty("id").GetString()!;
        Assert.StartsWith("vgl_", key);

        var request = Otlp.Logs("svc-key-test", 3);
        Assert.Equal(HttpStatusCode.OK, (await SendLogs(request, key)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendLogs(request, key + "x")).StatusCode);

        // La dernière utilisation est visible dans la liste (la clé elle-même n'est jamais renvoyée).
        var keys = await Get(admin, "/api/admin/keys");
        var listed = keys.GetProperty("keys").EnumerateArray().Single(k => k.GetProperty("id").GetString() == id);
        Assert.NotEqual(JsonValueKind.Null, listed.GetProperty("lastUsedAt").ValueKind);
        Assert.DoesNotContain(key, keys.GetRawText());

        await Post(admin, $"/api/admin/keys/{id}/revoke", new { });
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendLogs(request, key)).StatusCode);

        // Une clé navigateur (publique) ne permet pas l'ingestion OTLP serveur.
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/admin/keys", new { name = "site", kind = "browser" })).StatusCode);
        var browser = await Post(admin, "/api/admin/keys", new { name = "site", kind = "browser", origins = new[] { "https://app.exemple.fr" } });
        Assert.Equal(HttpStatusCode.Unauthorized, (await SendLogs(request, browser.GetProperty("key").GetString()!)).StatusCode);

        // Réservé aux administrateurs.
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.CreateClient().GetAsync("/api/admin/keys")).StatusCode);
    }

    [Fact]
    public async Task Resolved_errors_come_back_as_regressed()
    {
        var service = "svc-triage-" + Guid.NewGuid().ToString("N")[..6];
        var type = "Shop.PaymentDeclinedException";
        var t0 = DateTime.UtcNow.AddMinutes(-10);
        (await SendLogs(Exception(service, "1.0.0", type, t0), VigilServerFixture.ApiKey)).EnsureSuccessStatusCode();

        var ui = await server.LoggedInClient();
        var list = await Eventually(() => Get(ui, $"/api/errors?from=1h&service={service}&status=todo"), j => j.GetProperty("items").GetArrayLength() == 1);
        var group = list.GetProperty("items")[0];
        Assert.Equal("open", group.GetProperty("status").GetString());
        var fp = group.GetProperty("fingerprint").GetString()!;

        await Post(ui, $"/api/errors/{fp}/state", new { status = "resolved", assignedTo = "admin", note = "corrigé en 1.0.1" });
        list = await Get(ui, $"/api/errors?from=1h&service={service}&status=todo");
        Assert.Equal(0, list.GetProperty("items").GetArrayLength());
        Assert.Equal(1, list.GetProperty("counts").GetProperty("resolved").GetInt32());

        var detail = await Get(ui, $"/api/errors/{fp}?from=1h");
        Assert.Equal("resolved", detail.GetProperty("group").GetProperty("status").GetString());
        Assert.Equal("corrigé en 1.0.1", detail.GetProperty("state").GetProperty("note").GetString());
        Assert.Equal("admin", detail.GetProperty("group").GetProperty("assignedTo").GetString());

        // Nouvelle occurrence après la résolution (nouvelle version) : l'erreur réapparaît dans « à traiter ».
        (await SendLogs(Exception(service, "1.0.1", type, DateTime.UtcNow.AddSeconds(1)), VigilServerFixture.ApiKey)).EnsureSuccessStatusCode();
        list = await Eventually(() => Get(ui, $"/api/errors?from=1h&service={service}&status=todo"), j => j.GetProperty("items").GetArrayLength() == 1);
        Assert.Equal("regressed", list.GetProperty("items")[0].GetProperty("status").GetString());

        // La nouvelle version a été détectée comme un déploiement (la première version vue, non).
        var deployments = await Get(ui, $"/api/deployments?from=1h&service={service}");
        var d = Assert.Single(deployments.EnumerateArray());
        Assert.Equal("1.0.1", d.GetProperty("version").GetString());
        Assert.Equal("auto", d.GetProperty("source").GetString());

        // Ignorer : disparaît de la liste à traiter et de la vue d'ensemble.
        await Post(ui, "/api/errors/state", new { fingerprints = new[] { fp }, status = "ignored" });
        list = await Get(ui, $"/api/errors?from=1h&service={service}&status=todo");
        Assert.Equal(0, list.GetProperty("items").GetArrayLength());
        var overview = await Get(ui, "/api/overview?from=1h");
        Assert.DoesNotContain(overview.GetProperty("topErrors").EnumerateArray(), e => e.GetProperty("fingerprint").GetString() == fp);
    }

    [Fact]
    public async Task Deployments_can_be_declared_by_the_ci()
    {
        var client = server.CreateClient();
        using var message = new HttpRequestMessage(HttpMethod.Post, "/v1/deployments")
        {
            Content = JsonContent.Create(new { service = "svc-ci", env = "prod", version = "2.3.0", description = "Build 481" }),
        };
        message.Headers.Add("x-vigil-key", VigilServerFixture.ApiKey);
        (await client.SendAsync(message)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/v1/deployments", new { service = "x", version = "1" })).StatusCode);

        var ui = await server.LoggedInClient();
        var list = await Get(ui, "/api/deployments?from=1h&service=svc-ci");
        var d = Assert.Single(list.EnumerateArray());
        Assert.Equal("api", d.GetProperty("source").GetString());
        Assert.Equal("Build 481", d.GetProperty("description").GetString());
        Assert.Equal("prod", d.GetProperty("env").GetString());
    }

    [Fact]
    public async Task Saved_searches_are_private_unless_shared()
    {
        var admin = await server.LoggedInClient();
        var name = "collegue-" + Guid.NewGuid().ToString("N")[..6];
        var temporary = (await Post(admin, "/api/admin/users", new { username = name, role = "viewer" })).GetProperty("temporaryPassword").GetString()!;
        var viewer = await Login(name, temporary);

        var mine = await Post(admin, "/api/searches", new { name = "Paiements KO", page = "logs", @params = new { q = "paiement", level = "error" } });
        await Post(admin, "/api/searches", new { name = "Lentes", page = "requests", @params = new { minMs = "500" }, shared = true });
        await Post(viewer, "/api/searches", new { name = "Mes timeouts", page = "logs", @params = new { q = "timeout" }, shared = true });

        var seenByViewer = (await Get(viewer, "/api/searches")).EnumerateArray().ToList();
        Assert.Contains(seenByViewer, s => s.GetProperty("name").GetString() == "Lentes");
        Assert.DoesNotContain(seenByViewer, s => s.GetProperty("name").GetString() == "Paiements KO");
        // Un lecteur ne peut pas partager : sa recherche reste privée.
        Assert.False(seenByViewer.Single(s => s.GetProperty("name").GetString() == "Mes timeouts").GetProperty("shared").GetBoolean());
        Assert.DoesNotContain((await Get(admin, "/api/searches?page=logs")).EnumerateArray(), s => s.GetProperty("name").GetString() == "Mes timeouts");

        Assert.Equal(HttpStatusCode.NotFound, (await viewer.DeleteAsync($"/api/searches/{mine.GetProperty("id").GetString()}x")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.DeleteAsync($"/api/searches/{mine.GetProperty("id").GetString()}")).StatusCode);
        (await admin.DeleteAsync($"/api/searches/{mine.GetProperty("id").GetString()}")).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Logs_can_be_exported_as_csv_and_json()
    {
        var service = "svc-export-" + Guid.NewGuid().ToString("N")[..6];
        var request = Otlp.Logs(service, 30, DateTime.UtcNow.AddMinutes(-5), i => new LogRecord
        {
            SeverityNumber = SeverityNumber.Info,
            Body = new OpenTelemetry.Proto.Common.V1.AnyValue { StringValue = i == 0 ? "=cmd|' /C calc'!A0; \"guillemets\"" : $"ligne {i}" },
        });
        (await SendLogs(request, VigilServerFixture.ApiKey)).EnsureSuccessStatusCode();
        var ui = await server.LoggedInClient();
        await Eventually(() => Get(ui, $"/api/logs?from=1h&service={service}"), j => j.GetProperty("items").GetArrayLength() == 30);

        var csv = await ui.GetAsync($"/api/logs/export?from=1h&service={service}&format=csv");
        csv.EnsureSuccessStatusCode();
        Assert.Equal("text/csv", csv.Content.Headers.ContentType?.MediaType);
        Assert.Contains("attachment", csv.Content.Headers.ContentDisposition?.ToString());
        var lines = (await csv.Content.ReadAsStringAsync()).TrimStart('﻿').Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(31, lines.Length); // en-tête + 30 logs
        Assert.StartsWith("horodatage;niveau;service", lines[0]);
        // Pas de formule interprétée par Excel, guillemets échappés.
        Assert.Contains(lines, l => l.Contains("\"'=cmd|' /C calc'!A0; \"\"guillemets\"\"\""));

        var json = await Get(ui, $"/api/logs/export?from=1h&service={service}&format=json&limit=10");
        Assert.Equal(10, json.GetArrayLength());
        Assert.Equal(service, json[0].GetProperty("service").GetString());
    }
}
