using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;

namespace Wolflog.Tests;

/// <summary>Serveur Wolflog complet en mémoire dont les échanges avec Microsoft (login.microsoftonline.com) sont simulés.</summary>
public sealed class SsoServerFixture : WebApplicationFactory<Program>
{
    public const string Password = "test-password";
    private readonly TempDir _dir = new();

    public string DataDirectory => _dir.Path;
    public FakeEntraHandler Entra { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Wolflog:DataDirectory", _dir.Path);
        builder.UseSetting("Wolflog:Auth:Enabled", "true");
        builder.UseSetting("Wolflog:Auth:AdminPassword", Password);
        builder.UseSetting("Wolflog:Auth:ApiKeys:0", "sso-test-key");
        builder.UseSetting("Wolflog:Storage:FlushIntervalSeconds", "3600");
        builder.ConfigureTestServices(s => s.AddHttpClient("sso").ConfigurePrimaryHttpMessageHandler(() => Entra));
    }

    /// <summary>Navigateur connecté (cookies conservés, redirections non suivies).</summary>
    public async Task<HttpClient> Login(string username, string password)
    {
        var client = Browser();
        (await client.PostAsJsonAsync("/api/auth/login", new { username, password })).EnsureSuccessStatusCode();
        return client;
    }

    /// <summary>Navigateur anonyme : cookies conservés, redirections non suivies (pour lire leur destination).</summary>
    public HttpClient Browser() => CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true, AllowAutoRedirect = false });

    /// <summary>Navigateur en HTTPS : les cookies « Secure » de la connexion OpenID Connect (corrélation, nonce) lui sont rendus.</summary>
    public HttpClient SecureBrowser() => CreateClient(new WebApplicationFactoryClientOptions
    {
        HandleCookies = true, AllowAutoRedirect = false, BaseAddress = new Uri("https://localhost"),
    });

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        _dir.Dispose();
    }
}
