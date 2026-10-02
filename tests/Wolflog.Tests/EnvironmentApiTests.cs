using System.IO.Compression;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Wolflog.Tests;

/// <summary>
/// Environnements par l'API : réglages réservés aux administrateurs, sélecteur par application, filtres (données, alertes,
/// déploiements), valeurs reçues sur 30 jours, regroupement automatique et sauvegarde de la configuration.
/// </summary>
public class EnvironmentApiTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task<JsonElement> Read(HttpResponseMessage response)
    {
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode} : {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    private static string[] Strings(JsonElement array) => [.. array.EnumerateArray().Select(e => e.GetString()!)];

    /// <summary>Logs d'une application, avec la valeur d'environnement qu'elle envoie, écrits directement dans le stockage du serveur.</summary>
    private async Task Send(string service, string env, int count, DateTime? at = null)
    {
        var request = Otlp.Logs(service, count, at);
        request.ResourceLogs[0].Resource.Attributes.Single(a => a.Key == "deployment.environment.name").Value.StringValue = env;
        await server.Storage.Logs.IngestAsync(OtlpConverter.ConvertLogs(request), request.ToByteArray());
    }

    /// <summary>production regroupe prod et prd ; preproduction, staging. Pour b, « prod » est la préproduction ; a masque la préproduction.</summary>
    private static object Settings(string a, string b) => new
    {
        environments = new object[]
        {
            new { name = "production", label = "Production", kind = "production", aliases = new[] { "prod", "prd" } },
            new { name = "preproduction", label = "Préproduction", kind = "recette", color = "#0EA5E9", aliases = new[] { "staging" } },
        },
        apps = new object[]
        {
            new { service = b, aliases = new Dictionary<string, string> { ["prod"] = "preproduction" } },
            new { service = a, hidden = new[] { "preproduction" } },
        },
    };

    private async Task<HttpClient> Viewer()
    {
        var admin = await server.LoggedInClient();
        var name = "lecteur-" + Guid.NewGuid().ToString("N")[..6];
        var created = await Read(await admin.PostAsJsonAsync("/api/admin/users", new { username = name, role = "viewer" }));
        var viewer = server.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        var password = created.GetProperty("temporaryPassword").GetString();
        (await viewer.PostAsJsonAsync("/api/auth/login", new { username = name, password })).EnsureSuccessStatusCode();
        return viewer;
    }

    [Fact]
    public async Task Only_admins_change_environments()
    {
        var admin = await server.LoggedInClient();
        var saved = await Read(await admin.PutAsJsonAsync("/api/admin/environments", Settings("app-a", "app-b")));
        Assert.Equal("admin", saved.GetProperty("updatedBy").GetString());
        Assert.Equal(["production", "preproduction"], saved.GetProperty("environments").EnumerateArray().Select(e => e.GetProperty("name").GetString()));
        Assert.Equal("#0ea5e9", saved.GetProperty("environments")[1].GetProperty("color").GetString());

        var anonymous = server.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/admin/environments")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/environments/stats")).StatusCode);

        // Un lecteur voit les environnements (barre du haut), sans pouvoir les régler.
        var viewer = await Viewer();
        (await viewer.GetAsync("/api/environments/stats")).EnsureSuccessStatusCode();
        (await viewer.GetAsync("/api/environments?service=app-a")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.GetAsync("/api/admin/environments")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PutAsJsonAsync("/api/admin/environments", new { environments = Array.Empty<object>() })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/admin/environments/suggest", new { })).StatusCode);
        var unchanged = await Read(await admin.GetAsync("/api/admin/environments"));
        Assert.Equal(2, unchanged.GetProperty("environments").GetArrayLength());

        // Réglages refusés avec la raison, sans rien modifier.
        var refused = await admin.PutAsJsonAsync("/api/admin/environments", new
        {
            environments = new[] { new { name = "production", aliases = new[] { "prod" } }, new { name = "recette", aliases = new[] { "PROD" } } },
        });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Contains("à la fois", (await refused.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString());
        Assert.Equal(2, (await Read(await admin.GetAsync("/api/admin/environments"))).GetProperty("environments").GetArrayLength());
    }

    [Fact]
    public async Task Selector_and_filters_follow_the_saved_settings()
    {
        var id = Guid.NewGuid().ToString("N")[..6];
        string a = "envapi-a-" + id, b = "envapi-b-" + id;
        var admin = await server.LoggedInClient();
        await Read(await admin.PutAsJsonAsync("/api/admin/environments", Settings(a, b)));
        await Send(a, "prod", 4);
        await Send(a, "staging", 2);
        await Send(b, "prod", 3);
        await Send(b, "production", 6);

        // Sélecteur d'une application : ses environnements, dans l'ordre, sans ceux qu'elle masque.
        Assert.Equal(["production"], Strings(await Read(await admin.GetAsync($"/api/environments?service={a}"))));
        Assert.Equal(["production", "preproduction"], Strings(await Read(await admin.GetAsync($"/api/environments?service={b}"))));
        var forB = await Read(await admin.GetAsync($"/api/environments/stats?service={b}&env=demo"));
        var production = forB[0];
        Assert.Equal("Production", production.GetProperty("label").GetString());
        Assert.Equal("danger", production.GetProperty("tone").GetString());
        Assert.True(production.GetProperty("configured").GetBoolean());
        Assert.Equal(6, production.GetProperty("logs").GetInt64());
        Assert.Equal(["production"], Strings(production.GetProperty("raw")));
        var preproduction = forB[1];
        Assert.Equal(("Préproduction", "warn", "#0ea5e9", 1), (preproduction.GetProperty("label").GetString(), preproduction.GetProperty("tone").GetString(),
            preproduction.GetProperty("color").GetString(), preproduction.GetProperty("order").GetInt32()));
        Assert.Equal(3, preproduction.GetProperty("logs").GetInt64());
        Assert.Equal(b, preproduction.GetProperty("apps")[0].GetProperty("service").GetString());
        Assert.Equal(["prod"], Strings(preproduction.GetProperty("apps")[0].GetProperty("raw")));

        // Toutes les applications : la préproduction regroupe le staging de a et le prod de b.
        var all = await Read(await admin.GetAsync("/api/environments/stats"));
        var grouped = all.EnumerateArray().Single(e => e.GetProperty("name").GetString() == "preproduction");
        var apps = grouped.GetProperty("apps").EnumerateArray().ToDictionary(x => x.GetProperty("service").GetString()!, x => Strings(x.GetProperty("raw")));
        Assert.Equal(["staging"], apps[a]);
        Assert.Equal(["prod"], apps[b]);

        // Filtres : environnement configuré (valeurs regroupées par application), ou valeur brute comme avant.
        async Task<Dictionary<string, int>> Logs(string env)
        {
            var page = await Read(await admin.GetAsync($"/api/logs?from=1h&service={a},{b}&env={env}&limit=1000"));
            return page.GetProperty("items").EnumerateArray()
                .GroupBy(l => $"{(l.GetProperty("service").GetString() == a ? "a" : "b")}/{l.GetProperty("env").GetString()}")
                .ToDictionary(g => g.Key, g => g.Count());
        }
        Assert.Equal(new Dictionary<string, int> { ["a/prod"] = 4, ["b/production"] = 6 }, await Logs("production"));
        Assert.Equal(new Dictionary<string, int> { ["a/staging"] = 2, ["b/prod"] = 3 }, await Logs("preproduction"));
        Assert.Equal(new Dictionary<string, int> { ["a/prod"] = 4, ["b/prod"] = 3 }, await Logs("prod"));
        var services = await Read(await admin.GetAsync("/api/services?from=1h&env=preproduction"));
        Assert.Contains(services.EnumerateArray(), s => s.GetProperty("name").GetString() == b);

        // Alertes : la règle d'un environnement le voit comme l'interface.
        async Task<double> Alert(string service, string env)
        {
            var evaluations = await Read(await admin.PostAsJsonAsync("/api/alerts/preview", new
            {
                name = "Volume", kind = "query", source = "logs", aggregate = "count", service, env, threshold = 0, windowMinutes = 60,
            }));
            return evaluations[0].GetProperty("value").GetDouble();
        }
        Assert.Equal(3, await Alert(b, "preproduction"));
        Assert.Equal(6, await Alert(b, "production"));
        Assert.Equal(4, await Alert(a, "production"));

        // Déploiements (repères des graphiques) : même rattachement.
        (await admin.PostAsJsonAsync("/api/deployments", new { service = b, env = "prod", version = "2.0." + id })).EnsureSuccessStatusCode();
        async Task<int> Deployments(string env) =>
            (await Read(await admin.GetAsync($"/api/deployments?from=1h&service={b}&env={env}"))).GetArrayLength();
        Assert.Equal(1, await Deployments("preproduction"));
        Assert.Equal(0, await Deployments("production"));
        Assert.Equal(1, await Deployments("prod"));
    }

    [Fact]
    public async Task Admin_page_lists_values_of_the_last_30_days_and_proposes_groups()
    {
        var service = "envapi-old-" + Guid.NewGuid().ToString("N")[..6];
        await Send(service, "Qualif", 2, DateTime.UtcNow.AddDays(-10));
        var admin = await server.LoggedInClient();

        var page = await Read(await admin.GetAsync("/api/admin/environments"));
        var seen = page.GetProperty("seen").EnumerateArray().Single(s => s.GetProperty("service").GetString() == service);
        Assert.Equal("Qualif", seen.GetProperty("env").GetString());
        Assert.Equal(2, seen.GetProperty("logs").GetInt64());
        // Le sélecteur ne regarde que les 7 derniers jours.
        Assert.Empty(Strings(await Read(await admin.GetAsync($"/api/environments?service={service}"))));

        // Proposition à partir de la saisie en cours (non enregistrée) : la valeur rejoint la recette.
        var proposal = await Read(await admin.PostAsJsonAsync("/api/admin/environments/suggest", new
        {
            environments = new[] { new { name = "recette", label = "Recette (équipe QA)", kind = "recette", aliases = new[] { "uat" } } },
        }));
        var recette = proposal.GetProperty("environments").EnumerateArray().Single(e => e.GetProperty("name").GetString() == "recette");
        Assert.Equal("Recette (équipe QA)", recette.GetProperty("label").GetString());
        Assert.Equal(["uat", "Qualif"], Strings(recette.GetProperty("aliases")));
        Assert.True(proposal.GetProperty("grouped").GetInt32() >= 1);
    }

    [Fact]
    public async Task Settings_are_saved_and_restored_with_the_configuration()
    {
        var admin = await server.LoggedInClient();
        await Read(await admin.PutAsJsonAsync("/api/admin/environments", Settings("sauve-a", "sauve-b")));

        var backup = await admin.GetAsync("/api/admin/backup");
        backup.EnsureSuccessStatusCode();
        var bytes = await backup.Content.ReadAsByteArrayAsync();
        using (var zip = new ZipArchive(new MemoryStream(bytes)))
            Assert.Contains(zip.Entries, e => e.FullName == "config/environments.json");

        // Réglages remplacés, puis restauration : tout revient, et s'applique aussitôt aux requêtes.
        await Read(await admin.PutAsJsonAsync("/api/admin/environments", new
        {
            environments = new[] { new { name = "production", label = "Prod modifiée", kind = "autre" } },
        }));
        await Send("sauve-b", "prod", 1);
        using var form = new MultipartFormDataContent { { new ByteArrayContent(bytes), "file", "sauvegarde.zip" } };
        (await admin.PostAsync("/api/admin/restore", form)).EnsureSuccessStatusCode();
        var restored = await Read(await admin.GetAsync("/api/admin/environments"));
        Assert.Equal(["Production", "Préproduction"], restored.GetProperty("environments").EnumerateArray().Select(e => e.GetProperty("label").GetString()));
        Assert.Equal(["sauve-a", "sauve-b"], restored.GetProperty("apps").EnumerateArray().Select(x => x.GetProperty("service").GetString()));
        Assert.Equal(["preproduction"], Strings(await Read(await admin.GetAsync("/api/environments?service=sauve-b"))));
    }
}
