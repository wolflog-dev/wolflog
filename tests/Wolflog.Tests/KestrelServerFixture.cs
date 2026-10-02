using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Wolflog.Tests;

/// <summary>
/// Serveur Wolflog complet sur un vrai Kestrel (ports libres sur 127.0.0.1), pour ce que TestServer ne sait pas faire :
/// la négociation Windows (NTLM ou Kerberos) se fait sur une vraie connexion.
/// </summary>
public sealed class KestrelServerFixture : WebApplicationFactory<Program>
{
    public const string Password = "test-password";
    private readonly TempDir _dir = new();

    public KestrelServerFixture() => UseKestrel();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Wolflog:DataDirectory", _dir.Path);
        builder.UseSetting("Wolflog:Auth:Enabled", "true");
        builder.UseSetting("Wolflog:Auth:AdminPassword", Password);
        builder.UseSetting("Wolflog:Auth:ApiKeys:0", "kestrel-test-key");
        builder.UseSetting("Wolflog:Storage:FlushIntervalSeconds", "3600");
        // Ports libres : 5080, 4317 et 4318 sont peut-être pris (démo, autre serveur).
        foreach (var endpoint in new[] { "Web", "OtlpHttp", "OtlpGrpc" })
            builder.UseSetting($"Kestrel:Endpoints:{endpoint}:Url", "http://127.0.0.1:0");
    }

    /// <summary>Adresse HTTP/1.1 de l'API (le point gRPC, en HTTP/2 seul, ne répond pas à /health en HTTP/1.1).</summary>
    public async Task<Uri> ApiAddress()
    {
        StartServer();
        var addresses = Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
        foreach (var address in addresses)
        {
            using var probe = new HttpClient { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(5) };
            try
            {
                if ((await probe.GetAsync("/health")).IsSuccessStatusCode) return new Uri(address);
            }
            catch (HttpRequestException) { }
        }
        throw new InvalidOperationException("Aucune adresse HTTP/1.1 du serveur de test ne répond.");
    }

    /// <summary>Navigateur réel : cookies conservés, redirections non suivies ; avec la session Windows si demandé.</summary>
    public static HttpClient Browser(Uri address, bool windowsSession) =>
        new(new HttpClientHandler { UseDefaultCredentials = windowsSession, AllowAutoRedirect = false, CookieContainer = new CookieContainer() })
        {
            BaseAddress = address,
            Timeout = TimeSpan.FromSeconds(30),
        };

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        _dir.Dispose();
    }
}
