using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;

namespace Wolflog.Tests;

/// <summary>Serveur Wolflog complet en mémoire (TestServer), avec authentification activée.</summary>
public sealed class WolflogServerFixture : WebApplicationFactory<Program>
{
    public const string ApiKey = "test-api-key-123";
    public const string Password = "test-password";
    private readonly TempDir _dir = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Wolflog:DataDirectory", _dir.Path);
        builder.UseSetting("Wolflog:Auth:Enabled", "true");
        builder.UseSetting("Wolflog:Auth:AdminPassword", Password);
        builder.UseSetting("Wolflog:Auth:ApiKeys:0", ApiKey);
        builder.UseSetting("Wolflog:Storage:FlushIntervalSeconds", "3600");
        // Notifications (webhooks, Teams, Slack) capturées au lieu d'être envoyées.
        builder.ConfigureTestServices(s => s.AddHttpClient("notifications").ConfigurePrimaryHttpMessageHandler(() => Notifications));
    }

    public CapturingHandler Notifications { get; } = new();

    public async Task<HttpClient> LoggedInClient()
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true });
        var login = await client.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = Password });
        login.EnsureSuccessStatusCode();
        return client;
    }

    public StorageHost Storage => Services.GetRequiredService<StorageHost>();

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        _dir.Dispose();
    }
}
