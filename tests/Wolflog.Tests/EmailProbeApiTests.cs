using Wolflog.Server.Monitoring;

namespace Wolflog.Tests;

/// <summary>Sonde e-mail par l'API : mots de passe jamais renvoyés ni enregistrés en clair, essai d'une sonde enregistrée.</summary>
public class EmailProbeApiTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>, IAsyncLifetime
{
    private readonly FakeMailServer _mail = new();

    public ValueTask InitializeAsync()
    {
        EmailProbeRunner.PollInterval = TimeSpan.FromMilliseconds(100);
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => _mail.DisposeAsync();

    private object Body(string? password, string? id = null) => new
    {
        id = id ?? "", name = "Messagerie de l'API", type = "email", intervalSeconds = 900, timeoutSeconds = 10, enabled = false,
        email = new
        {
            smtpHost = "127.0.0.1", smtpPort = _mail.SmtpPort, smtpSecurity = "none", smtpUser = FakeMailServer.User, smtpPassword = password,
            from = "sonde@exemple.test", to = "sonde@exemple.test",
            imapHost = "127.0.0.1", imapPort = _mail.ImapPort, imapSecurity = "none", imapUser = FakeMailServer.User, imapPassword = password,
            deliveryTimeoutSeconds = 15,
        },
    };

    [Fact]
    public async Task Passwords_are_never_returned_nor_stored_in_clear()
    {
        var client = await server.LoggedInClient();
        var created = await client.PostAsJsonAsync("/api/probes", Body(FakeMailServer.Password), TestContext.Current.CancellationToken);
        created.EnsureSuccessStatusCode();
        var createdText = await created.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.DoesNotContain(FakeMailServer.Password, createdText);
        var id = JsonDocument.Parse(createdText).RootElement.GetProperty("id").GetString()!;

        var list = await client.GetStringAsync("/api/probes", TestContext.Current.CancellationToken);
        Assert.DoesNotContain(FakeMailServer.Password, list);
        Assert.Contains("\"hasSmtpPassword\":true", list);
        Assert.DoesNotContain(FakeMailServer.Password, File.ReadAllText(Path.Combine(server.Storage.DataDirectory, "probes.json")));

        // Essai de la sonde enregistrée sans retaper le mot de passe : celui enregistré est utilisé.
        var test = await client.PostAsJsonAsync("/api/probes/test", Body(null, id), TestContext.Current.CancellationToken);
        test.EnsureSuccessStatusCode();
        var result = JsonDocument.Parse(await test.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).RootElement;
        Assert.True(result.GetProperty("ok").GetBoolean(), result.GetProperty("error").ToString());
        Assert.Equal(6, result.GetProperty("steps").GetArrayLength());
    }

    [Fact]
    public async Task Invalid_settings_are_explained()
    {
        var client = await server.LoggedInClient();
        var response = await client.PostAsJsonAsync("/api/probes", new { name = "Sans serveur", type = "email", intervalSeconds = 900, email = new { from = "a@b.test", to = "a@b.test" } },
            TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("serveur SMTP", await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }
}
