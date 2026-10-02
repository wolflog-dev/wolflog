using Microsoft.AspNetCore.Mvc.Testing;

namespace Wolflog.Tests;

/// <summary>
/// Tableaux de bord selon l'accès : un tableau n'est proposé que s'il est visible pour le profil (« Visible pour ») et qu'au moins
/// un de ses panneaux entre dans le profil ; les autres panneaux sont retirés de la réponse et conservés à l'enregistrement.
/// </summary>
public class DashboardAccessTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly string[] Defaults = ["http", "explorer", "browser", "runtime"];

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

    private static async Task<string?> Error(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString();

    private static string[] Ids(JsonElement list) => list.EnumerateArray().Select(d => d.GetProperty("id").GetString()!).ToArray();

    /// <summary>Profil d'exploitation avec les tableaux de bord (« Exploitation » fourni n'en a pas) ; son identifiant.</summary>
    private static async Task<string> OpsWithDashboards(HttpClient admin) =>
        (await Send(admin, HttpMethod.Post, "/api/admin/access-profiles", new
        {
            name = "Exploitation et tableaux " + Guid.NewGuid().ToString("N")[..4],
            sections = new[] { "overview", "dashboards", "logs", "metrics", "alerts", "uptime", "slos" },
        })).GetProperty("id").GetString()!;

    private async Task<HttpClient> NewUser(HttpClient admin, string role, string? profileId)
    {
        var username = "tdb-" + Guid.NewGuid().ToString("N")[..8];
        var created = await Send(admin, HttpMethod.Post, "/api/admin/users", new { username, role, profileId });
        var client = server.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        (await client.PostAsJsonAsync("/api/auth/login", new { username, password = created.GetProperty("temporaryPassword").GetString() })).EnsureSuccessStatusCode();
        return client;
    }

    [Fact]
    public async Task Dashboards_follow_the_access_profile()
    {
        var admin = await server.LoggedInClient();
        Assert.Equal(Defaults.Order(), Ids(await Get(admin, "/api/dashboards")).Where(id => Defaults.Contains(id)).Order());

        // Produit : aucun panneau des tableaux techniques n'entre dans le profil, ils ne sont ni listés ni lisibles.
        var po = await NewUser(admin, "viewer", "product");
        Assert.DoesNotContain(Ids(await Get(po, "/api/dashboards")), id => Defaults.Contains(id));
        var refused = await po.GetAsync("/api/dashboards/http");
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Contains("Aucun panneau", await Error(refused));

        // Exploitation : « Runtime .NET » en entier ; « Santé HTTP » réduit à son panneau de logs, les autres comptés à part.
        var ops = await NewUser(admin, "editor", await OpsWithDashboards(admin));
        var list = await Get(ops, "/api/dashboards");
        Assert.Contains("runtime", Ids(list));
        Assert.Equal(1, list.EnumerateArray().Single(d => d.GetProperty("id").GetString() == "http").GetProperty("panels").GetInt32());
        var http = await Get(ops, "/api/dashboards/http");
        var full = await Get(admin, "/api/dashboards/http");
        var visible = Assert.Single(http.GetProperty("panels").EnumerateArray());
        Assert.Equal("logs", visible.GetProperty("source").GetString());
        Assert.Equal(full.GetProperty("panels").GetArrayLength() - 1, http.GetProperty("hiddenPanels").GetInt32());
        Assert.False(full.TryGetProperty("hiddenPanels", out _));

        // Enregistrement par Exploitation : son panneau change, les panneaux qu'il ne voit pas restent à leur place.
        var edited = JsonSerializer.Deserialize<Dictionary<string, object?>>(http.GetRawText(), Json)!;
        var panel = JsonSerializer.Deserialize<Dictionary<string, object?>>(visible.GetRawText(), Json)!;
        panel["title"] = "Logs en erreur (exploitation)";
        edited["panels"] = new[] { panel };
        await Send(ops, HttpMethod.Put, "/api/dashboards/http", edited);
        var after = await Get(admin, "/api/dashboards/http");
        Assert.Equal(full.GetProperty("panels").EnumerateArray().Select(p => p.GetProperty("id").GetString()),
            after.GetProperty("panels").EnumerateArray().Select(p => p.GetProperty("id").GetString()));
        Assert.Contains(after.GetProperty("panels").EnumerateArray(), p => p.GetProperty("title").GetString() == "Logs en erreur (exploitation)");

        // Supprimer un tableau dont on ne voit pas tout : réservé à un administrateur.
        var delete = await ops.DeleteAsync("/api/dashboards/http");
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
        Assert.Contains("seul un administrateur", await Error(delete));
    }

    [Fact]
    public async Task Visibility_is_chosen_per_profile()
    {
        var admin = await server.LoggedInClient();
        var opsProfile = await OpsWithDashboards(admin);
        var created = await Send(admin, HttpMethod.Post, "/api/dashboards", new
        {
            name = "Exploitation seulement", visibleTo = new[] { opsProfile },
            panels = new[] { new { title = "Logs", type = "logs", width = 12, height = "m" } },
        });
        var id = created.GetProperty("id").GetString()!;
        Assert.Equal(new[] { opsProfile }, created.GetProperty("visibleTo").EnumerateArray().Select(v => v.GetString()));

        // Développeur (tout voir) : hors de « Visible pour ». Exploitation : visible. Administrateur : toujours.
        var dev = await NewUser(admin, "viewer", null);
        Assert.DoesNotContain(id, Ids(await Get(dev, "/api/dashboards")));
        var hidden = await dev.GetAsync($"/api/dashboards/{id}");
        Assert.Equal(HttpStatusCode.Forbidden, hidden.StatusCode);
        Assert.Contains("pas visible", await Error(hidden));
        var ops = await NewUser(admin, "editor", opsProfile);
        Assert.Contains(id, Ids(await Get(ops, "/api/dashboards")));
        Assert.Contains(id, Ids(await Get(admin, "/api/dashboards")));

        // Profil inconnu refusé ; une personne limitée garde son propre profil dans la liste.
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/dashboards", new { name = "x", visibleTo = new[] { "inconnu" }, panels = Array.Empty<object>() })).StatusCode);
        var own = await ops.PostAsJsonAsync("/api/dashboards", new { name = "Pour le produit", visibleTo = new[] { "product" }, panels = Array.Empty<object>() });
        Assert.Equal(HttpStatusCode.BadRequest, own.StatusCode);
        Assert.Contains("Gardez votre profil", await Error(own));
        await Send(ops, HttpMethod.Post, "/api/dashboards", new { name = "Pour le produit et nous", visibleTo = new[] { "product", opsProfile }, panels = Array.Empty<object>() });

        // Choix proposés à un éditeur limité : les profils par leur nom, sans leur contenu (réservé à l'administration).
        var audiences = (await Get(ops, "/api/dashboards/access-profiles")).EnumerateArray().ToList();
        Assert.Equal("all", audiences[0].GetProperty("id").GetString());
        Assert.Contains(audiences, p => p.GetProperty("id").GetString() == opsProfile && p.GetProperty("name").GetString()!.StartsWith("Exploitation et tableaux"));
        Assert.All(audiences, p => Assert.False(p.TryGetProperty("sections", out _) || p.TryGetProperty("users", out _)));

        // Profil supprimé depuis : retiré de « Visible pour » à l'enregistrement suivant, sans bloquer.
        var temporary = (await Send(admin, HttpMethod.Post, "/api/admin/access-profiles", new
        {
            name = "Éphémère " + Guid.NewGuid().ToString("N")[..4], sections = new[] { "dashboards" },
        })).GetProperty("id").GetString()!;
        var shared = await Send(admin, HttpMethod.Post, "/api/dashboards", new { name = "Partagé", visibleTo = new[] { temporary, opsProfile }, panels = Array.Empty<object>() });
        (await admin.DeleteAsync($"/api/admin/access-profiles/{temporary}")).EnsureSuccessStatusCode();
        var resaved = JsonSerializer.Deserialize<Dictionary<string, object?>>(shared.GetRawText(), Json)!;
        resaved["name"] = "Partagé (renommé)";
        var saved = await Send(ops, HttpMethod.Put, $"/api/dashboards/{shared.GetProperty("id").GetString()}", resaved);
        Assert.Equal(new[] { opsProfile }, saved.GetProperty("visibleTo").EnumerateArray().Select(v => v.GetString()));

        // Retour à « tout le monde ».
        var everyone = JsonSerializer.Deserialize<Dictionary<string, object?>>(created.GetRawText(), Json)!;
        everyone["visibleTo"] = Array.Empty<string>();
        await Send(admin, HttpMethod.Put, $"/api/dashboards/{id}", everyone);
        Assert.Contains(id, Ids(await Get(dev, "/api/dashboards")));
    }

    [Fact]
    public async Task Panels_of_hidden_services_are_hidden()
    {
        var admin = await server.LoggedInClient();
        var profile = await Send(admin, HttpMethod.Post, "/api/admin/access-profiles", new
        {
            name = "Logs boutique " + Guid.NewGuid().ToString("N")[..4], sections = new[] { "dashboards", "logs" }, services = new[] { "boutique-*" },
        });
        var created = await Send(admin, HttpMethod.Post, "/api/dashboards", new
        {
            name = "Par service",
            panels = new object[]
            {
                new { title = "Compta", type = "logs", service = "compta", width = 6, height = "m" },
                new { title = "Boutique", type = "logs", service = "boutique-web", width = 6, height = "m" },
                new { title = "Variable", type = "logs", service = "$service", width = 6, height = "m" },
            },
        });
        var user = await NewUser(admin, "viewer", profile.GetProperty("id").GetString());
        var seen = await Get(user, $"/api/dashboards/{created.GetProperty("id").GetString()}");
        Assert.Equal(new[] { "Boutique", "Variable" }, seen.GetProperty("panels").EnumerateArray().Select(p => p.GetProperty("title").GetString()));
        Assert.Equal(1, seen.GetProperty("hiddenPanels").GetInt32());
    }
}
