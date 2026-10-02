namespace Wolflog.Tests;

/// <summary>
/// Connexion Windows de bout en bout, comme le bouton « Se connecter avec Windows » : vrai serveur Kestrel, vraie négociation
/// avec la session Windows qui exécute les tests (Kerberos sur un PC du domaine, sinon NTLM), sans mot de passe saisi.
/// Windows seulement : ailleurs, le test est ignoré.
/// </summary>
public class WindowsSignInTests
{
    [Fact]
    public async Task The_windows_session_signs_in_without_a_password()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Authentification Windows intégrée : seulement sous Windows.");
        await using var server = new KestrelServerFixture();
        var address = await server.ApiAddress();

        // Sans réglage, la connexion Windows n'existe pas.
        using var person = KestrelServerFixture.Browser(address, windowsSession: true);
        Assert.Equal(HttpStatusCode.NotFound, (await person.GetAsync("/api/auth/windows")).StatusCode);

        // L'administrateur l'active (Administration > Connexion SSO).
        using var admin = KestrelServerFixture.Browser(address, windowsSession: false);
        (await admin.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = KestrelServerFixture.Password })).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/admin/sso", new
        {
            microsoftEnabled = false, windowsEnabled = true, autoSignIn = "", defaultRole = "viewer",
            allowedDomains = Array.Empty<string>(), groupMappings = Array.Empty<object>(),
        })).EnsureSuccessStatusCode();
        Assert.True((await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("sso").GetProperty("windows").GetBoolean());

        // « Se connecter avec Windows » : la session répond à la négociation, puis retour à la page demandée.
        var signIn = await person.GetAsync("/api/auth/windows?returnUrl=/dashboards");
        Assert.Equal(HttpStatusCode.Redirect, signIn.StatusCode);
        Assert.EndsWith("/dashboards", signIn.Headers.Location!.OriginalString);

        // Compte créé au premier passage : nom Windows (DOMAINE\compte, ou POSTE\compte hors domaine), rôle par défaut.
        var me = await person.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.True(me.GetProperty("authenticated").GetBoolean());
        Assert.Equal("sso", me.GetProperty("source").GetString());
        Assert.Equal("viewer", me.GetProperty("role").GetString());
        Assert.Equal($"{Environment.UserDomainName}\\{Environment.UserName}", me.GetProperty("user").GetString(), ignoreCase: true);

        // Deuxième passage : même compte, pas de doublon.
        using var again = KestrelServerFixture.Browser(address, windowsSession: true);
        Assert.Equal(HttpStatusCode.Redirect, (await again.GetAsync("/api/auth/windows")).StatusCode);
        var users = await admin.GetFromJsonAsync<JsonElement>("/api/admin/users");
        Assert.Single(users.EnumerateArray(), u => string.Equals(u.GetProperty("username").GetString(),
            $"{Environment.UserDomainName}\\{Environment.UserName}", StringComparison.OrdinalIgnoreCase));
    }
}
