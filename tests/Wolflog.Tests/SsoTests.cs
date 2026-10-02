using Microsoft.AspNetCore.WebUtilities;

namespace Wolflog.Tests;

/// <summary>
/// Connexion unique réglée dans l'interface : réglages réservés aux administrateurs (secret jamais renvoyé), méthodes
/// annoncées à la page de connexion, redirection vers Microsoft sans redémarrage, connexion Windows, test de l'inscription.
/// </summary>
public class SsoTests(SsoServerFixture server) : IClassFixture<SsoServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task<JsonElement> Get(HttpClient client, string url)
    {
        var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
    }

    /// <summary>Réglages Microsoft Entra ID du locataire simulé.</summary>
    private static object Settings(bool microsoft = true, string? secret = FakeEntraHandler.Secret, bool windows = false, string auto = "") => new
    {
        microsoftEnabled = microsoft,
        tenant = FakeEntraHandler.Tenant,
        clientId = FakeEntraHandler.ClientId,
        clientSecret = secret,
        buttonLabel = "Microsoft",
        windowsEnabled = windows,
        autoSignIn = auto,
        allowedDomains = new[] { "contoso.fr" },
        defaultRole = "viewer",
        defaultProfileId = (string?)null,
        groupMappings = new[] { new { group = "4f0c5b1e-2b7d-4c55-9a0e-6a1f2b3c4d5e", name = "Équipe Wolflog", role = "admin", profileId = (string?)null } },
    };

    private Task<HttpClient> Admin() => server.Login("admin", SsoServerFixture.Password);

    [Fact]
    public async Task Settings_are_for_admins_only_and_the_secret_never_leaves_the_server()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await server.Browser().GetAsync("/api/admin/sso")).StatusCode);

        var admin = await Admin();
        var name = "lecteur-" + Guid.NewGuid().ToString("N")[..6];
        var created = await (await admin.PostAsJsonAsync("/api/admin/users", new { username = name, role = "viewer" })).Content.ReadFromJsonAsync<JsonElement>(Json);
        var viewer = await server.Login(name, created.GetProperty("temporaryPassword").GetString()!);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.GetAsync("/api/admin/sso")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PutAsJsonAsync("/api/admin/sso", Settings())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsJsonAsync("/api/admin/sso/test", new { tenant = FakeEntraHandler.Tenant })).StatusCode);

        var saved = await admin.PutAsJsonAsync("/api/admin/sso", Settings());
        saved.EnsureSuccessStatusCode();
        var text = await saved.Content.ReadAsStringAsync();
        Assert.DoesNotContain(FakeEntraHandler.Secret, text);
        var view = JsonSerializer.Deserialize<JsonElement>(text, Json);
        Assert.True(view.GetProperty("settings").GetProperty("hasSecret").GetBoolean());
        Assert.True(view.GetProperty("active").GetProperty("microsoft").GetBoolean());
        Assert.Equal("Équipe Wolflog", view.GetProperty("settings").GetProperty("groupMappings")[0].GetProperty("name").GetString());

        // Enregistré sans secret : celui déjà enregistré est conservé. Ni l'API ni le fichier ne le montrent en clair.
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings(secret: null))).EnsureSuccessStatusCode();
        var read = await admin.GetStringAsync("/api/admin/sso");
        Assert.DoesNotContain(FakeEntraHandler.Secret, read);
        Assert.True(JsonSerializer.Deserialize<JsonElement>(read, Json).GetProperty("active").GetProperty("microsoft").GetBoolean());
        var file = await File.ReadAllTextAsync(Path.Combine(server.DataDirectory, "sso.json"));
        Assert.DoesNotContain(FakeEntraHandler.Secret, file);
        Assert.Contains("protectedClientSecret", file);
        // Clés de chiffrement dans le dossier de données : les sessions et le secret survivent aux redémarrages.
        Assert.NotEmpty(Directory.GetFiles(Path.Combine(server.DataDirectory, "data-protection"), "key-*.xml"));

        // Réglages invalides : message clair, rien n'est enregistré.
        var common = await admin.PutAsJsonAsync("/api/admin/sso", new { microsoftEnabled = true, tenant = "common", clientId = FakeEntraHandler.ClientId });
        Assert.Equal(HttpStatusCode.BadRequest, common.StatusCode);
        Assert.Contains("tous les comptes Microsoft", (await common.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Login_page_learns_the_available_methods_and_auto_sign_in()
    {
        var admin = await Admin();
        var browser = server.Browser();
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings(microsoft: false))).EnsureSuccessStatusCode();
        Assert.Equal(JsonValueKind.Null, (await Get(browser, "/api/auth/me")).GetProperty("sso").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync("/api/auth/sso")).StatusCode);

        (await admin.PutAsJsonAsync("/api/admin/sso", Settings(auto: "microsoft"))).EnsureSuccessStatusCode();
        var sso = (await Get(browser, "/api/auth/me")).GetProperty("sso");
        Assert.Equal("Microsoft", sso.GetProperty("name").GetString());
        Assert.True(sso.GetProperty("microsoft").GetBoolean());
        Assert.False(sso.GetProperty("windows").GetBoolean());
        Assert.False(sso.GetProperty("oidc").GetBoolean());
        Assert.Equal("microsoft", sso.GetProperty("autoRedirect").GetString());

        // Après une déconnexion volontaire, pas de connexion automatique : elle reconnecterait aussitôt la personne.
        (await admin.PostAsync("/api/auth/logout", null)).EnsureSuccessStatusCode();
        Assert.Equal(JsonValueKind.Null, (await Get(admin, "/api/auth/me")).GetProperty("sso").GetProperty("autoRedirect").ValueKind);

        // Connexion automatique vers une méthode inactive : ignorée.
        (await (await Admin()).PutAsJsonAsync("/api/admin/sso", Settings(auto: "windows"))).EnsureSuccessStatusCode();
        Assert.Equal(JsonValueKind.Null, (await Get(browser, "/api/auth/me")).GetProperty("sso").GetProperty("autoRedirect").ValueKind);
    }

    [Fact]
    public async Task Microsoft_sign_in_follows_the_saved_settings_without_restart()
    {
        var admin = await Admin();
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings())).EnsureSuccessStatusCode();
        var browser = server.Browser();

        var challenge = await browser.GetAsync("/api/auth/sso?returnUrl=%2Flogs");
        Assert.Equal(HttpStatusCode.Redirect, challenge.StatusCode);
        var location = challenge.Headers.Location!;
        Assert.Equal($"https://login.microsoftonline.com/{FakeEntraHandler.TenantId}/oauth2/v2.0/authorize", location.GetLeftPart(UriPartial.Path));
        var query = QueryHelpers.ParseQuery(location.Query);
        Assert.Equal(FakeEntraHandler.ClientId, query["client_id"]);
        Assert.Equal("http://localhost/signin-oidc", query["redirect_uri"]);
        Assert.Equal("S256", query["code_challenge_method"]);
        Assert.Contains("openid", query["scope"].ToString());

        // Adresse publique de Wolflog renseignée (Alertes > Canaux) : c'est elle que Microsoft rappelle, et celle à déclarer.
        (await admin.PutAsJsonAsync("/api/notification-settings", new { publicUrl = "https://wolflog.contoso.fr/" })).EnsureSuccessStatusCode();
        var behindProxy = await browser.GetAsync("/api/auth/sso");
        Assert.Equal("https://wolflog.contoso.fr/signin-oidc", QueryHelpers.ParseQuery(behindProxy.Headers.Location!.Query)["redirect_uri"]);
        Assert.Equal("https://wolflog.contoso.fr/signin-oidc", (await Get(admin, "/api/admin/sso")).GetProperty("redirectUri").GetString());
        (await admin.PutAsJsonAsync("/api/notification-settings", new { publicUrl = "" })).EnsureSuccessStatusCode();

        // Désactivée : plus de schéma, plus de redirection.
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings(microsoft: false))).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync("/api/auth/sso")).StatusCode);
    }

    [Fact]
    public async Task Microsoft_sign_in_creates_the_account_from_the_signed_token()
    {
        var admin = await Admin();
        (await admin.PutAsJsonAsync("/api/admin/sso", Settings())).EnsureSuccessStatusCode();

        // Aller-retour complet : demande d'autorisation, retour sur /signin-oidc avec le code, échange contre un jeton signé.
        async Task<HttpResponseMessage> SignIn(HttpClient browser, Dictionary<string, object> identity)
        {
            var challenge = await browser.GetAsync("/api/auth/sso?returnUrl=%2Flogs");
            var query = QueryHelpers.ParseQuery(challenge.Headers.Location!.Query);
            server.Entra.Nonce = query["nonce"];
            server.Entra.NextIdentity = identity;
            return await browser.PostAsync("/signin-oidc", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["code"] = "code-de-test",
                ["state"] = query["state"].ToString(),
            }));
        }

        // Membre du groupe qui donne le rôle administrateur (ID d'objet du groupe Entra ID).
        var browser = server.SecureBrowser();
        var signedIn = await SignIn(browser, new()
        {
            ["preferred_username"] = "jdupont@contoso.fr",
            ["name"] = "Jeanne Dupont",
            ["groups"] = new[] { "4f0c5b1e-2b7d-4c55-9a0e-6a1f2b3c4d5e", "autre-groupe" },
        });
        Assert.Equal(HttpStatusCode.Redirect, signedIn.StatusCode);
        Assert.Equal("/logs", signedIn.Headers.Location!.OriginalString);
        var me = await Get(browser, "/api/auth/me");
        Assert.True(me.GetProperty("authenticated").GetBoolean());
        Assert.Equal("jdupont@contoso.fr", me.GetProperty("user").GetString());
        Assert.Equal("Jeanne Dupont", me.GetProperty("displayName").GetString());
        Assert.Equal("admin", me.GetProperty("role").GetString());
        Assert.Equal("sso", me.GetProperty("source").GetString());

        // Domaine non autorisé : aucun compte, retour à la page de connexion avec la raison ; l'administrateur voit le détail.
        var outsider = await SignIn(server.SecureBrowser(), new() { ["preferred_username"] = "mallory@fabrikam.com", ["name"] = "Mallory" });
        Assert.Equal("/login?sso=domain", outsider.Headers.Location!.OriginalString);
        var failure = (await Get(admin, "/api/admin/sso")).GetProperty("lastFailure");
        Assert.Contains("mallory@fabrikam.com", failure.GetProperty("message").GetString());
        Assert.DoesNotContain((await Get(admin, "/api/admin/users")).EnumerateArray(), u => u.GetProperty("username").GetString() == "mallory@fabrikam.com");
    }

    [Fact]
    public async Task Windows_sign_in_is_404_when_disabled_and_refused_on_a_server_without_windows_authentication()
    {
        var browser = server.Browser();
        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync("/api/auth/windows?returnUrl=%2F")).StatusCode);

        // Serveur de test (ni Kestrel ni IIS) : activer Windows est refusé avec une explication, et rien ne casse.
        var admin = await Admin();
        var refused = await admin.PutAsJsonAsync("/api/admin/sso", Settings(microsoft: false, windows: true));
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Contains("authentification Windows", (await refused.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString());
        var view = await Get(admin, "/api/admin/sso");
        Assert.False(view.GetProperty("windowsHost").GetProperty("supported").GetBoolean());
        Assert.False(view.GetProperty("active").GetProperty("windows").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync("/api/auth/windows")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/dashboards")).StatusCode);
    }

    [Fact]
    public async Task Access_profiles_given_by_sso_must_exist()
    {
        var admin = await Admin();
        var unknown = await admin.PutAsJsonAsync("/api/admin/sso", new { defaultRole = "viewer", defaultProfileId = "inexistant" });
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        Assert.Contains("n'existe pas", (await unknown.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("error").GetString());
        var unknownGroup = await admin.PutAsJsonAsync("/api/admin/sso", new { defaultRole = "viewer", groupMappings = new[] { new { group = "g-x", profileId = "inexistant" } } });
        Assert.Equal(HttpStatusCode.BadRequest, unknownGroup.StatusCode);

        // « Tout voir » par défaut = aucun profil ; explicite dans un groupe, il élargit un profil par défaut restreint.
        var saved = await admin.PutAsJsonAsync("/api/admin/sso", new
        {
            defaultRole = "viewer",
            defaultProfileId = "all",
            groupMappings = new[] { new { group = "g-ops", profileId = "ops" }, new { group = "g-dev", profileId = "all" } },
        });
        saved.EnsureSuccessStatusCode();
        var settings = (await saved.Content.ReadFromJsonAsync<JsonElement>(Json)).GetProperty("settings");
        Assert.Equal(JsonValueKind.Null, settings.GetProperty("defaultProfileId").ValueKind);
        Assert.Equal("ops", settings.GetProperty("groupMappings")[0].GetProperty("profileId").GetString());
        Assert.Equal("all", settings.GetProperty("groupMappings")[1].GetProperty("profileId").GetString());
    }

    [Fact]
    public async Task Registration_test_explains_microsoft_errors()
    {
        var admin = await Admin();
        async Task<JsonElement> Check(object body)
        {
            var response = await admin.PostAsJsonAsync("/api/admin/sso/test", body);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<JsonElement>(Json);
        }

        var unknown = await Check(new { tenant = "fabrikam.onmicrosoft.com", clientId = FakeEntraHandler.ClientId, clientSecret = "x" });
        Assert.False(unknown.GetProperty("ok").GetBoolean());
        Assert.Contains("Locataire introuvable", unknown.GetProperty("steps")[0].GetProperty("message").GetString());

        var secretId = await Check(new { tenant = FakeEntraHandler.Tenant, clientId = FakeEntraHandler.ClientId, clientSecret = "5c2d1e0f-id-du-secret" });
        Assert.True(secretId.GetProperty("steps")[0].GetProperty("ok").GetBoolean());
        Assert.False(secretId.GetProperty("steps")[1].GetProperty("ok").GetBoolean());
        Assert.Contains("« Valeur »", secretId.GetProperty("steps")[1].GetProperty("message").GetString());

        // Adresse du locataire collée telle quelle : réduite au locataire.
        var ok = await Check(new { tenant = $"https://login.microsoftonline.com/{FakeEntraHandler.Tenant}/v2.0", clientId = FakeEntraHandler.ClientId, clientSecret = FakeEntraHandler.Secret });
        Assert.True(ok.GetProperty("ok").GetBoolean());
        Assert.Equal(FakeEntraHandler.TenantId, ok.GetProperty("tenantId").GetString());
    }
}
