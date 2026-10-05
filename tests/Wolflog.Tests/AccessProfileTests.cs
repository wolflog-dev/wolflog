using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Primitives;
using Wolflog.Server.Api;
using Wolflog.Server.Security;

namespace Wolflog.Tests;

/// <summary>Profils d'accès : parties de Wolflog visibles par compte, contrôlées par le serveur à chaque appel de l'API.</summary>
public class AccessProfileTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static async Task<JsonElement> Send(HttpClient client, HttpMethod method, string url, object body)
    {
        var response = await client.SendAsync(new HttpRequestMessage(method, url) { Content = JsonContent.Create(body) });
        response.EnsureSuccessStatusCode();
        var text = await response.Content.ReadAsStringAsync();
        return string.IsNullOrEmpty(text) ? default : JsonSerializer.Deserialize<JsonElement>(text, Json);
    }

    private static async Task<string?> Error(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString();

    private static string[] Strings(JsonElement array) => array.EnumerateArray().Select(e => e.GetString()!).ToArray();

    /// <summary>Compte créé par l'administrateur (profil null : aucun), puis connecté avec son mot de passe provisoire.</summary>
    private async Task<(HttpClient Client, string Id)> NewUser(HttpClient admin, string role, string? profileId)
    {
        var username = "acces-" + Guid.NewGuid().ToString("N")[..8];
        var created = await Send(admin, HttpMethod.Post, "/api/admin/users", new { username, role, profileId });
        var client = server.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        var password = created.GetProperty("temporaryPassword").GetString();
        (await client.PostAsJsonAsync("/api/auth/login", new { username, password })).EnsureSuccessStatusCode();
        return (client, created.GetProperty("user").GetProperty("id").GetString()!);
    }

    [Fact]
    public async Task Profiles_limit_what_each_user_can_see()
    {
        var admin = await server.LoggedInClient();
        var (po, poId) = await NewUser(admin, "viewer", "product");

        // Ce que reçoit l'interface : parties du profil, dans l'ordre de la navigation, et page d'accueil.
        var me = await Get(po, "/api/auth/me");
        Assert.Equal(new[] { "dashboards", "audience", "clickmaps" }, Strings(me.GetProperty("sections")));
        Assert.Equal("audience", me.GetProperty("home").GetString());
        Assert.Equal("product", me.GetProperty("profile").GetProperty("id").GetString());
        Assert.Equal("Produit", me.GetProperty("profile").GetProperty("name").GetString());

        // Parties du profil et routes communes : autorisées.
        foreach (var url in new[]
                 {
                     "/api/analytics/summary?from=1h", "/api/analytics/realtime", "/api/analytics/clickmaps?from=1h", "/api/dashboards",
                     "/api/services?from=7d", "/api/environments", "/api/environments/stats", "/api/searches", "/api/deployments?from=1h",
                     "/api/people", "/api/fields?source=logs",
                 })
            Assert.True((await po.GetAsync(url)).IsSuccessStatusCode, url);

        // Hors du profil : 403 et un message qui dit pourquoi.
        var denied = await po.GetAsync("/api/logs?from=1h");
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        var body = await denied.Content.ReadFromJsonAsync<JsonElement>(Json);
        Assert.Equal("Votre profil d'accès « Produit » ne donne pas accès à « Logs ».", body.GetProperty("error").GetString());
        Assert.Equal("logs", body.GetProperty("section").GetString());
        foreach (var url in new[]
                 {
                     "/api/logs/histogram?from=1h", "/api/logs/export?from=1h", "/api/requests?from=1h", "/api/requests/export?from=1h",
                     "/api/traces?from=1h", "/api/errors?from=1h", "/api/metrics?from=1h", "/api/service-map?from=1h", "/api/overview?from=1h",
                     "/api/system", "/api/health/wolflog", "/api/profiles", "/api/profiling/instances", "/api/alerts", "/api/alerts/active",
                     "/api/alert-channels", "/api/probes", "/api/slos", "/api/fields/values?source=logs&key=service",
                 })
            Assert.True((await po.GetAsync(url)).StatusCode == HttpStatusCode.Forbidden, url);

        // Flux en direct : refusé avant son ouverture.
        using (var tail = await po.GetAsync("/api/logs/tail", HttpCompletionOption.ResponseHeadersRead))
            Assert.Equal(HttpStatusCode.Forbidden, tail.StatusCode);

        // Nouveau profil : appliqué dès l'appel suivant, sans se reconnecter.
        await Send(admin, HttpMethod.Put, $"/api/admin/users/{poId}", new { profileId = "ops" });
        (await po.GetAsync("/api/logs?from=1h")).EnsureSuccessStatusCode();
        (await po.GetAsync("/api/alerts")).EnsureSuccessStatusCode();
        (await po.GetAsync("/api/probes")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await po.GetAsync("/api/analytics/summary?from=1h")).StatusCode);
        Assert.Equal("overview", (await Get(po, "/api/auth/me")).GetProperty("home").GetString());

        // Sans profil : tout voir.
        await Send(admin, HttpMethod.Put, $"/api/admin/users/{poId}", new { profileId = "" });
        (await po.GetAsync("/api/traces?from=1h")).EnsureSuccessStatusCode();
        me = await Get(po, "/api/auth/me");
        Assert.Equal(AccessSections.All, Strings(me.GetProperty("sections")));
        Assert.Equal("all", me.GetProperty("profile").GetProperty("id").GetString());
    }

    [Fact]
    public async Task Custom_queries_follow_their_data_source()
    {
        var admin = await server.LoggedInClient();
        var (ops, _) = await NewUser(admin, "viewer", "ops");
        (await ops.GetAsync("/api/query?from=1h&source=logs&agg=count")).EnsureSuccessStatusCode();
        (await ops.GetAsync("/api/query?from=1h&source=metrics&agg=count")).EnsureSuccessStatusCode();
        (await ops.GetAsync("/api/fields/values?from=1h&source=logs&key=service")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await ops.GetAsync("/api/query?from=1h&source=spans&agg=count")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ops.GetAsync("/api/fields/values?from=1h&source=spans&key=name")).StatusCode);

        var (po, _) = await NewUser(admin, "viewer", "product");
        Assert.Equal(HttpStatusCode.Forbidden, (await po.GetAsync("/api/query?from=1h")).StatusCode);
        // Source inconnue du moteur : il interroge les logs, l'accès suit les logs.
        Assert.Equal(HttpStatusCode.Forbidden, (await po.GetAsync("/api/query?from=1h&source=analytics")).StatusCode);

        // Profil « requêtes HTTP » : spans et détail d'une trace (panneau d'une requête), mais pas la liste des traces.
        var support = await Send(admin, HttpMethod.Post, "/api/admin/access-profiles",
            new { name = "Support " + Guid.NewGuid().ToString("N")[..6], sections = new[] { "requests", "errors" } });
        var (agent, _) = await NewUser(admin, "viewer", support.GetProperty("id").GetString());
        (await agent.GetAsync("/api/query?from=1h&source=spans&agg=count")).EnsureSuccessStatusCode();
        (await agent.GetAsync($"/api/traces/{new string('a', 32)}")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await agent.GetAsync("/api/traces?from=1h")).StatusCode);
    }

    [Fact]
    public async Task Grafana_api_is_not_a_way_around_a_profile()
    {
        var admin = await server.LoggedInClient();
        (await admin.GetAsync("/api/grafana/logs?from=1h")).EnsureSuccessStatusCode();

        // Session d'un profil restreint : refusée (elle lirait des logs fermés dans l'interface).
        var (po, _) = await NewUser(admin, "viewer", "product");
        var denied = await po.GetAsync("/api/grafana/logs?from=1h");
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Contains("clé de lecture", await Error(denied));

        // Clé de lecture : accès inchangé, quelle que soit la session.
        var key = await Send(admin, HttpMethod.Post, "/api/admin/keys", new { name = "Grafana " + Guid.NewGuid().ToString("N")[..6], kind = "read" });
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/grafana/logs?from=1h");
        request.Headers.Add("x-wolflog-key", key.GetProperty("key").GetString());
        (await po.SendAsync(request)).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Admins_always_see_everything()
    {
        var admin = await server.LoggedInClient();
        var me = await Get(admin, "/api/auth/me");
        Assert.Equal(AccessSections.All, Strings(me.GetProperty("sections")));
        Assert.Equal(JsonValueKind.Null, me.GetProperty("profile").ValueKind);
        Assert.Equal("overview", me.GetProperty("home").GetString());

        // Profil d'un administrateur : sans effet tant qu'il le reste.
        var (boss, bossId) = await NewUser(admin, "admin", "product");
        (await boss.GetAsync("/api/logs?from=1h")).EnsureSuccessStatusCode();
        (await boss.GetAsync("/api/admin/access-profiles")).EnsureSuccessStatusCode();

        // Rétrogradé : le profil s'applique aussitôt. Rôle (ce qu'on fait) et profil (ce qu'on voit) se combinent.
        await Send(admin, HttpMethod.Put, $"/api/admin/users/{bossId}", new { role = "editor" });
        Assert.Equal(HttpStatusCode.Forbidden, (await boss.GetAsync("/api/logs?from=1h")).StatusCode);
        (await boss.PostAsJsonAsync("/api/dashboards", new { name = "Tableau produit", panels = Array.Empty<object>() })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await boss.PostAsJsonAsync("/api/alerts", new { name = "Erreurs", kind = "error" })).StatusCode);
    }

    [Fact]
    public async Task Access_profiles_are_validated()
    {
        var admin = await server.LoggedInClient();
        var list = await Get(admin, "/api/admin/access-profiles");
        Assert.Equal(new[] { "all", "product", "ops" }, list.EnumerateArray().Take(3).Select(p => p.GetProperty("id").GetString()!));
        Assert.True(list[0].GetProperty("builtin").GetBoolean());
        Assert.Equal(AccessSections.All, Strings(list[0].GetProperty("sections")));

        foreach (var (input, message) in new (object, string)[]
                 {
                     (new { name = " ", sections = new[] { "logs" } }, "Donnez un nom"),
                     (new { name = "Vide", sections = Array.Empty<string>() }, "Cochez au moins une partie"),
                     (new { name = "Inconnue", sections = new[] { "logs", "replays" } }, "inconnue : « replays »"),
                     (new { name = "Accueil", sections = new[] { "logs" }, home = "traces" }, "page d'accueil"),
                     (new { name = "produit", sections = new[] { "logs" } }, "Un profil s'appelle déjà"),
                 })
        {
            var refused = await admin.PostAsJsonAsync("/api/admin/access-profiles", input);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Contains(message, await Error(refused));
        }

        // Création : identifiant lisible, parties dédoublonnées et remises dans l'ordre de la navigation.
        var suffix = Guid.NewGuid().ToString("N")[..6];
        var created = await Send(admin, HttpMethod.Post, "/api/admin/access-profiles",
            new { name = $"Équipe support {suffix}", sections = new[] { "errors", "logs", "logs" }, home = "errors", icon = "shield" });
        var id = created.GetProperty("id").GetString()!;
        Assert.Equal($"equipe-support-{suffix}", id);
        Assert.Equal(new[] { "logs", "errors" }, Strings(created.GetProperty("sections")));
        Assert.Equal("errors", created.GetProperty("home").GetString());
        Assert.Equal("shield", created.GetProperty("icon").GetString());
        Assert.False(created.GetProperty("builtin").GetBoolean());

        // Modification partielle : la page d'accueil retombe sur une partie encore visible.
        var updated = await Send(admin, HttpMethod.Put, $"/api/admin/access-profiles/{id}", new { sections = new[] { "logs", "metrics" } });
        Assert.Equal("logs", updated.GetProperty("home").GetString());
        Assert.Equal($"Équipe support {suffix}", updated.GetProperty("name").GetString());

        // « Tout voir » donne toujours accès à tout.
        var all = await Send(admin, HttpMethod.Put, "/api/admin/access-profiles/all", new { sections = new[] { "logs" } });
        Assert.Equal(AccessSections.All, Strings(all.GetProperty("sections")));

        // Comptes : profil inconnu refusé ; profil attribué : suppression refusée tant qu'un compte l'utilise.
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/admin/users", new { username = "x-" + suffix, profileId = "nope" })).StatusCode);
        var (_, userId) = await NewUser(admin, "viewer", id);
        var users = await Get(admin, "/api/admin/users");
        Assert.Equal(id, users.EnumerateArray().Single(u => u.GetProperty("id").GetString() == userId).GetProperty("profileId").GetString());
        Assert.Equal(1, (await Get(admin, "/api/admin/access-profiles")).EnumerateArray().Single(p => p.GetProperty("id").GetString() == id).GetProperty("users").GetInt32());
        var assigned = await admin.DeleteAsync($"/api/admin/access-profiles/{id}");
        Assert.Equal(HttpStatusCode.BadRequest, assigned.StatusCode);
        Assert.Contains("attribué à 1 utilisateur", await Error(assigned));
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.DeleteAsync("/api/admin/access-profiles/product")).StatusCode);

        // « all » : retour à « Tout voir » (aucun profil enregistré), puis suppression possible.
        await Send(admin, HttpMethod.Put, $"/api/admin/users/{userId}", new { profileId = "all" });
        users = await Get(admin, "/api/admin/users");
        Assert.Equal(JsonValueKind.Null, users.EnumerateArray().Single(u => u.GetProperty("id").GetString() == userId).GetProperty("profileId").ValueKind);
        (await admin.DeleteAsync($"/api/admin/access-profiles/{id}")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync($"/api/admin/access-profiles/{id}")).StatusCode);

        // Réservé aux administrateurs.
        var (viewer, _) = await NewUser(admin, "viewer", null);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.GetAsync("/api/admin/access-profiles")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/admin/access-profiles", new { name = "x", sections = new[] { "logs" } })).StatusCode);
    }

    [Fact]
    public void Every_api_route_belongs_to_a_section()
    {
        var routes = server.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Select(e => (Route: e.RoutePattern.RawText ?? "", Methods: e.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? ["GET"]))
            .Where(r => r.Route.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
                        && !r.Route.StartsWith("/api/auth", StringComparison.OrdinalIgnoreCase)
                        && !r.Route.StartsWith("/api/grafana", StringComparison.OrdinalIgnoreCase)
                        && !r.Route.StartsWith("/api/heatmap", StringComparison.OrdinalIgnoreCase))
            .SelectMany(r => r.Methods.Select(m => (r.Route, Method: m)))
            .ToList();
        Assert.True(routes.Count > 80, $"{routes.Count} routes trouvées seulement");
        var missing = routes.Where(r => ApiSections.For(r.Route, r.Method, QueryCollection.Empty) is null).Select(r => $"{r.Method} {r.Route}").ToList();
        Assert.True(missing.Count == 0, "Routes à rattacher à une partie de Wolflog (Api/ApiSections.cs) :\n" + string.Join("\n", missing));
    }

    [Theory]
    [InlineData("/api/logs/tail", "GET", null, "logs")]
    [InlineData("/api/logs/export", "GET", null, "logs")]
    [InlineData("/api/requests/export", "GET", null, "requests")]
    [InlineData("/api/traces", "GET", null, "traces")]
    [InlineData("/api/traces/{traceId}", "GET", null, "traces,requests")]
    [InlineData("/api/errors/{fingerprint}/state", "POST", null, "errors")]
    [InlineData("/api/analytics/realtime", "GET", null, "audience")]
    [InlineData("/api/analytics/events/{name}/properties", "GET", null, "audience")]
    [InlineData("/api/analytics/clickmap", "GET", null, "clickmaps")]
    [InlineData("/api/analytics/frustrations", "GET", null, "clickmaps")]
    [InlineData("/api/probes", "GET", null, "uptime,alerts,slos")]
    [InlineData("/api/probes", "POST", null, "uptime")]
    [InlineData("/api/slos", "GET", null, "slos,alerts")]
    [InlineData("/api/slos/{id}", "GET", null, "slos")]
    [InlineData("/api/query", "GET", null, "logs")]
    [InlineData("/api/query", "GET", "spans", "traces,requests")]
    [InlineData("/api/query", "GET", "metrics", "metrics")]
    [InlineData("/api/query", "GET", "analytics", "logs")]
    [InlineData("/api/fields", "GET", "spans", "")]
    [InlineData("/api/fields/values", "GET", "spans", "traces,requests")]
    [InlineData("/api/system", "GET", null, "overview")]
    [InlineData("/api/system/flush", "POST", null, "")]
    [InlineData("/api/services", "GET", null, "")]
    [InlineData("/api/admin/access-profiles/{id}", "DELETE", null, "")]
    [InlineData("/api/nouvelle-route", "GET", null, null)]
    public void Routes_belong_to_sections(string route, string method, string? source, string? expected)
    {
        var store = new Dictionary<string, StringValues>();
        if (source is not null) store["source"] = source;
        var sections = ApiSections.For(route, method, new QueryCollection(store));
        Assert.Equal(expected, sections is null ? null : string.Join(',', sections));
    }
}
