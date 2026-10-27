using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Wolflog.Server;
using Wolflog.Server.Monitoring;

namespace Wolflog.Tests;

/// <summary>
/// Messageries Microsoft (OAuth XOAUTH2) : compte connecté par code, renouvellement des jetons, application Entra ID ;
/// et détection des réglages d'une messagerie à partir de l'adresse (DNS).
/// </summary>
public class MicrosoftMailTests : IAsyncLifetime
{
    private readonly FakeMailServer _mail = new();
    private readonly FakeMicrosoftMail _microsoft;
    private readonly IDataProtectionProvider _protection = new EphemeralDataProtectionProvider();
    private readonly WolflogServerOptions _options = new();
    private readonly MicrosoftMailTokens _tokens;
    private readonly EmailProbeSecrets _secrets;
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    public MicrosoftMailTests()
    {
        EmailProbeRunner.PollInterval = TimeSpan.FromMilliseconds(100);
        EmailProbeRunner.MinimumDeliveryTimeoutSeconds = 1;
        _microsoft = new FakeMicrosoftMail(_mail);
        // Le faux serveur de messagerie tient lieu de serveur Microsoft.
        _options.Mail.MicrosoftHosts.Add("127.0.0.1");
        _tokens = new MicrosoftMailTokens(new Factory(_microsoft), _protection, Options.Create(_options), NullLogger<MicrosoftMailTokens>.Instance);
        _secrets = new EmailProbeSecrets(_protection, _tokens);
    }

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public ValueTask DisposeAsync() => _mail.DisposeAsync();

    private Probe NewProbe(MicrosoftMailAuth auth) => new()
    {
        Id = "", Name = "Messagerie Microsoft", Type = "email", IntervalSeconds = 300, TimeoutSeconds = 10,
        Email = new EmailProbeSettings
        {
            Auth = "microsoft", Microsoft = auth,
            SmtpHost = "127.0.0.1", SmtpPort = _mail.SmtpPort, SmtpSecurity = "none",
            From = "Sonde <sonde@exemple.test>", To = "sonde@exemple.test",
            ImapHost = "127.0.0.1", ImapPort = _mail.ImapPort, ImapSecurity = "none", DeliveryTimeoutSeconds = 10,
        },
    };

    private Task<ProbeResult> Run(Probe p) =>
        new EmailProbeRunner(_secrets, NullLogger<EmailProbeRunner>.Instance, _tokens).RunAsync(p, Ct);

    /// <summary>Connexion par code : en attente tant que le code n'est pas saisi, puis le compte connecté.</summary>
    private async Task<string> ConnectAccount()
    {
        var start = await _tokens.StartAsync(FakeMicrosoftMail.Tenant, FakeMicrosoftMail.ClientId, "admin", Ct);
        Assert.Equal("ABCD-EFGH", start.UserCode);
        Assert.Equal("https://microsoft.com/devicelogin", start.VerificationUri);
        Assert.Equal("pending", (await _tokens.PollAsync(start.Id, "admin", Ct)).Status);
        // Une autre personne ne peut pas reprendre la connexion.
        Assert.Equal("error", (await _tokens.PollAsync(start.Id, "quelquun", Ct)).Status);
        var done = await _tokens.PollAsync(start.Id, "admin", Ct);
        Assert.Equal("ok", done.Status);
        Assert.Equal(FakeMailServer.User, done.Account);
        return start.Id;
    }

    [Fact]
    public async Task Connected_account_sends_and_receives_and_renews_its_token()
    {
        var connection = await ConnectAccount();
        var probe = NewProbe(new MicrosoftMailAuth { Mode = "account", Tenant = FakeMicrosoftMail.Tenant, ClientId = FakeMicrosoftMail.ClientId, ConnectionId = connection });
        _secrets.Prepare(probe, null, "admin");
        var auth = probe.Email!.Microsoft!;
        Assert.Equal(FakeMailServer.User, auth.Account);
        Assert.NotNull(auth.ProtectedRefreshToken);
        Assert.DoesNotContain("renouvellement", auth.ProtectedRefreshToken); // chiffré

        var result = await Run(probe);
        Assert.True(result.Ok, result.Error);
        Assert.Equal(["Jeton Microsoft", "Connexion SMTP", "Authentification SMTP", "Envoi", "Connexion IMAP", "Authentification IMAP", "Réception"],
            result.Steps!.Select(s => s.Name));
        Assert.Contains("(Microsoft)", result.Steps![2].Detail);

        // Renouvellement : le nouveau jeton remplace l'ancien (ici l'ancien est refusé ensuite, comme après 90 jours).
        _tokens.ForgetAccessTokens();
        var before = auth.ProtectedRefreshToken;
        Assert.True((await Run(probe)).Ok);
        Assert.NotEqual(before, auth.ProtectedRefreshToken);
        _tokens.ForgetAccessTokens();
        Assert.True((await Run(probe)).Ok);
        Assert.Equal(2, _microsoft.Grants.Count(g => g == "refresh_token"));

        // Pour l'interface : aucun secret, seulement l'état de la connexion.
        var shown = EmailProbeSecrets.ForDisplay(probe).Email!.Microsoft!;
        Assert.True(shown.Connected);
        Assert.Null(shown.ProtectedRefreshToken);
        Assert.Equal(FakeMailServer.User, shown.Account);
    }

    [Fact]
    public async Task Company_relay_sends_and_the_microsoft_mailbox_receives()
    {
        // Envoi par le relais de l'entreprise (« localhost » : pas un serveur de Microsoft), sans identifiant ;
        // réception dans la boîte Microsoft 365 (127.0.0.1 tient lieu de serveur Microsoft) avec le jeton.
        _mail.RequireAuth = false;
        var probe = NewProbe(new MicrosoftMailAuth { Mode = "account", Tenant = FakeMicrosoftMail.Tenant, ClientId = FakeMicrosoftMail.ClientId, ConnectionId = await ConnectAccount() });
        probe.Email!.SmtpHost = "localhost";
        _secrets.Prepare(probe, null, "admin");

        var result = await Run(probe);
        Assert.True(result.Ok, result.Error);
        Assert.Equal(["Connexion SMTP", "Envoi", "Jeton Microsoft", "Connexion IMAP", "Authentification IMAP", "Réception"], result.Steps!.Select(s => s.Name));
        Assert.Equal(0, _mail.SmtpAuthAttempts); // ni jeton ni mot de passe présenté au relais

        // Relais qui demande un compte : son identifiant et son mot de passe, le jeton restant pour la boîte.
        _mail.RequireAuth = true;
        var withAccount = NewProbe(new MicrosoftMailAuth { Mode = "account", Tenant = FakeMicrosoftMail.Tenant, ClientId = FakeMicrosoftMail.ClientId });
        withAccount.Email!.SmtpHost = "localhost";
        withAccount.Email.SmtpUser = FakeMailServer.User;
        withAccount.Email.SmtpPassword = FakeMailServer.Password;
        _secrets.Prepare(withAccount, probe, "admin");
        Assert.NotNull(withAccount.Email.ProtectedSmtpPassword);
        Assert.Equal(probe.Email.Microsoft!.ProtectedRefreshToken, withAccount.Email.Microsoft!.ProtectedRefreshToken);
        var relayed = await Run(withAccount);
        Assert.True(relayed.Ok, relayed.Error);
        Assert.Equal(FakeMailServer.User, relayed.Steps!.Single(s => s.Name == "Authentification SMTP").Detail);
    }

    [Fact]
    public async Task Token_is_never_presented_to_a_server_that_is_not_microsoft()
    {
        // Ni le serveur d'envoi ni celui de la boîte ne sont de Microsoft : envoi sans jeton (relais), boîte refusée.
        _options.Mail.MicrosoftHosts.Remove("127.0.0.1");
        _mail.RequireAuth = false;
        var probe = NewProbe(new MicrosoftMailAuth { Mode = "account", Tenant = FakeMicrosoftMail.Tenant, ClientId = FakeMicrosoftMail.ClientId, ConnectionId = await ConnectAccount() });
        _secrets.Prepare(probe, null, "admin");

        var result = await Run(probe);
        Assert.False(result.Ok);
        Assert.StartsWith("Authentification IMAP : 127.0.0.1 n'est pas un serveur de Microsoft", result.Error);
        Assert.Equal(0, _mail.SmtpAuthAttempts);
    }

    [Fact]
    public async Task Entra_application_uses_its_secret_kept_only_for_the_same_application()
    {
        var auth = new MicrosoftMailAuth { Mode = "app", Tenant = FakeMicrosoftMail.Tenant, ClientId = FakeMicrosoftMail.ClientId, ClientSecret = "mauvais" };
        var probe = NewProbe(auth);
        probe.Email!.SmtpUser = FakeMailServer.User;
        _secrets.Prepare(probe, null, "admin");
        var failed = await Run(probe);
        Assert.False(failed.Ok);
        Assert.Equal("Jeton Microsoft", failed.Steps!.Single(s => !s.Ok).Name);
        Assert.Contains("Secret client invalide", failed.Error);

        var fixedProbe = NewProbe(new MicrosoftMailAuth { Mode = "app", Tenant = FakeMicrosoftMail.Tenant, ClientId = FakeMicrosoftMail.ClientId, ClientSecret = FakeMicrosoftMail.Secret });
        fixedProbe.Email!.SmtpUser = FakeMailServer.User;
        _secrets.Prepare(fixedProbe, null, "admin");
        var ok = await Run(fixedProbe);
        Assert.True(ok.Ok, ok.Error);
        Assert.Contains("client_credentials", _microsoft.Grants);

        // Secret laissé vide : conservé pour la même application, oublié si l'application change.
        var edited = NewProbe(new MicrosoftMailAuth { Mode = "app", Tenant = FakeMicrosoftMail.Tenant, ClientId = FakeMicrosoftMail.ClientId });
        _secrets.Prepare(edited, fixedProbe, "admin");
        Assert.Equal(fixedProbe.Email.Microsoft!.ProtectedClientSecret, edited.Email!.Microsoft!.ProtectedClientSecret);
        var other = NewProbe(new MicrosoftMailAuth { Mode = "app", Tenant = FakeMicrosoftMail.Tenant, ClientId = Guid.NewGuid().ToString() });
        _secrets.Prepare(other, fixedProbe, "admin");
        Assert.Null(other.Email!.Microsoft!.ProtectedClientSecret);
    }

    [Fact]
    public async Task Microsoft_errors_become_instructions()
    {
        var ex = await Assert.ThrowsAsync<MicrosoftMailException>(() => _tokens.StartAsync(FakeMicrosoftMail.Tenant, Guid.NewGuid().ToString(), "admin", Ct));
        Assert.Contains("Application introuvable", ex.Message);
        Assert.Contains("AADSTS700016", ex.Message);
        await Assert.ThrowsAsync<MicrosoftMailException>(() => _tokens.StartAsync(FakeMicrosoftMail.Tenant, "pas-un-guid", "admin", Ct));
        Assert.Equal("consumers", MicrosoftMailTokens.DefaultTenant("moi@outlook.fr"));
        Assert.Equal("contoso.fr", MicrosoftMailTokens.DefaultTenant("Sonde <healthcheck@Contoso.fr>"));
        Assert.Contains("SMTP AUTH", MailTransport.MicrosoftAdvice("5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant."));
        // Direct Send et connecteur : le point d'entrée MX n'est pas un serveur d'envoi authentifié.
        Assert.True(MailTransport.IsMicrosoftMxEndpoint("contoso-com.mail.protection.outlook.com"));
        Assert.False(MailTransport.IsMicrosoftMxEndpoint("smtp.office365.com"));
        Assert.Contains("laissez « Compte » vide", MailTransport.Describe(new NotSupportedException("The SMTP server does not support authentication.")));
    }

    [Fact]
    public async Task Detects_mail_settings_from_the_address()
    {
        using var dns = new FakeDnsServer();
        MailSettingsDetector.ConnectTimeout = TimeSpan.FromMilliseconds(300);
        var detector = new MailSettingsDetector(new MailDns([dns.EndPoint]));
        dns.Records[("societe-m365.test", MailDns.Mx)] = ["0 societe-m365-test.mail.protection.outlook.com"];
        dns.Records[("passerelle.test", MailDns.Mx)] = ["10 eu-smtp-inbound-1.mimecast.com", "20 eu-smtp-inbound-2.mimecast.com"];
        dns.Records[("passerelle.test", MailDns.Txt)] = ["MS=ms12345678", "v=spf1 include:spf.protection.outlook.com include:_netblocks.mimecast.com -all"];
        dns.Records[("ovh-client.test", MailDns.Mx)] = ["1 mx1.mail.ovh.net"];
        dns.Records[("interne.test", MailDns.Mx)] = ["10 mx.interne.test"];
        dns.Records[("_submission._tcp.interne.test", MailDns.Srv)] = ["0 1 587 smtp.interne.test"];
        dns.Records[("_imaps._tcp.interne.test", MailDns.Srv)] = ["0 1 993 imap.interne.test"];

        var m365 = await detector.DetectAsync("healthcheck.mail@societe-m365.test", Ct);
        Assert.Equal("microsoft365", m365.Provider);
        Assert.Equal("microsoft", m365.Auth);
        Assert.Equal(new MailSettingsDetector.Server("smtp.office365.com", 587, "starttls"), m365.Smtp);
        Assert.Equal("MX : societe-m365-test.mail.protection.outlook.com", m365.Evidence);

        // Passerelle antispam devant Microsoft 365 : reconnu par le SPF (TXT en plusieurs morceaux).
        var gateway = await detector.DetectAsync("Sonde <sonde@passerelle.test>", Ct);
        Assert.Equal("microsoft365", gateway.Provider);
        Assert.Contains("SPF : include:spf.protection.outlook.com", gateway.Evidence);
        Assert.Contains("mimecast", gateway.Evidence);

        Assert.Equal("ovh", (await detector.DetectAsync("contact@ovh-client.test", Ct)).Provider);
        var srv = await detector.DetectAsync("contact@interne.test", Ct);
        Assert.Equal("other", srv.Provider);
        Assert.Equal(new MailSettingsDetector.Server("smtp.interne.test", 587, "starttls"), srv.Smtp);
        Assert.Equal(new MailSettingsDetector.Server("imap.interne.test", 993, "ssl"), srv.Imap);

        Assert.Equal("google", (await detector.DetectAsync("moi@gmail.com", Ct)).Provider);
        Assert.Equal("unknown", (await detector.DetectAsync("pas une adresse", Ct)).Provider);
        Assert.Equal("unknown", (await detector.DetectAsync("x@inexistant.test", Ct)).Provider);
    }
}
