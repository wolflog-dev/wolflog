using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;
using Wolflog.Server.Monitoring;

namespace Wolflog.Tests;

/// <summary>Sonde e-mail de bout en bout (envoi SMTP, réception IMAP) contre un faux serveur, avec le vrai client MailKit.</summary>
public class EmailProbeTests : IAsyncLifetime
{
    private readonly FakeMailServer _mail = new();
    private readonly EmailProbeSecrets _secrets = new(new EphemeralDataProtectionProvider());

    public EmailProbeTests()
    {
        EmailProbeRunner.PollInterval = TimeSpan.FromMilliseconds(100);
        EmailProbeRunner.MinimumDeliveryTimeoutSeconds = 1;
    }

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public ValueTask DisposeAsync() => _mail.DisposeAsync();

    private Probe NewProbe(string? smtpPassword = FakeMailServer.Password, bool receive = true, int deliverySeconds = 10)
    {
        var probe = new Probe
        {
            Id = "p1", Name = "Messagerie", Type = "email", IntervalSeconds = 300, TimeoutSeconds = 10,
            Email = new EmailProbeSettings
            {
                SmtpHost = "127.0.0.1", SmtpPort = _mail.SmtpPort, SmtpSecurity = "none",
                SmtpUser = FakeMailServer.User, SmtpPassword = smtpPassword,
                From = "Wolflog <sonde@exemple.test>", To = "sonde@exemple.test",
                ImapHost = receive ? "127.0.0.1" : null, ImapPort = _mail.ImapPort, ImapSecurity = "none",
                ImapUser = FakeMailServer.User, ImapPassword = FakeMailServer.Password,
                DeliveryTimeoutSeconds = deliverySeconds,
            },
        };
        _secrets.Prepare(probe, null);
        return probe;
    }

    private Task<ProbeResult> Run(Probe p) => new EmailProbeRunner(_secrets, NullLogger<EmailProbeRunner>.Instance).RunAsync(p, TestContext.Current.CancellationToken);

    [Fact]
    public async Task Finds_the_message_when_the_server_cannot_search_headers()
    {
        // Exchange Online : SEARCH HEADER sur X-Wolflog-Probe ne trouve rien ; les en-têtes des derniers messages sont lus.
        _mail.HeaderSearch = false;
        _mail.Deposit("INBOX", "From: a@exemple.test\r\nSubject: courrier ordinaire\r\n\r\nbonjour\r\n");
        _mail.Deposit("INBOX", $"From: a@exemple.test\r\n{EmailProbeRunner.Header}: p1.reste-d-un-ancien-essai\r\nSubject: x\r\n\r\nancien\r\n");

        var result = await Run(NewProbe());

        Assert.True(result.Ok, result.Error);
        Assert.Equal("Réception", result.Steps![^1].Name);
        Assert.Equal(1, _mail.Count("INBOX")); // message de test et reste d'ancien essai supprimés, courrier ordinaire gardé
    }

    [Fact]
    public async Task Sends_receives_and_cleans_up()
    {
        var result = await Run(NewProbe());

        Assert.True(result.Ok, result.Error);
        Assert.Equal(["Connexion SMTP", "Authentification SMTP", "Envoi", "Connexion IMAP", "Authentification IMAP", "Réception"], result.Steps!.Select(s => s.Name));
        Assert.All(result.Steps!, s => Assert.True(s.Ok, s.Name));
        Assert.Contains("queued", result.Steps![2].Detail);
        Assert.True(result.DurationMs >= 250, $"délai de livraison mesuré : {result.DurationMs} ms"); // livraison après 300 ms
        Assert.Equal(0, _mail.Count("INBOX")); // message de test supprimé dès son arrivée
    }

    [Fact]
    public async Task Sending_only_when_no_mailbox_is_given()
    {
        var result = await Run(NewProbe(receive: false));
        Assert.True(result.Ok, result.Error);
        Assert.Equal(["Connexion SMTP", "Authentification SMTP", "Envoi"], result.Steps!.Select(s => s.Name));
        Assert.Equal(1, _mail.Accepted);
    }

    [Fact]
    public async Task Wrong_password_fails_at_the_authentication_step()
    {
        var result = await Run(NewProbe(smtpPassword: "mauvais"));
        Assert.False(result.Ok);
        Assert.StartsWith("Authentification SMTP : identifiant ou mot de passe refusé", result.Error);
        Assert.False(result.Steps!.Last().Ok);
        Assert.Equal(0, _mail.Accepted);
    }

    [Fact]
    public async Task Unreachable_server_is_reported_at_connection()
    {
        var probe = NewProbe();
        probe.Email!.SmtpPort = 1; // port fermé
        var result = await Run(probe);
        Assert.False(result.Ok);
        Assert.StartsWith("Connexion SMTP : ", result.Error);
    }

    [Fact]
    public async Task Message_accepted_but_never_delivered_is_a_failure()
    {
        _mail.DeliverTo = null;
        var result = await Run(NewProbe(deliverySeconds: 1));
        Assert.False(result.Ok);
        Assert.Contains("non arrivé", result.Error);
        Assert.Contains("envoi pourtant accepté", result.Error);
    }

    [Fact]
    public async Task Message_in_the_junk_folder_is_a_failure_or_a_warning()
    {
        _mail.DeliverTo = "Junk";
        var failure = await Run(NewProbe());
        Assert.False(failure.Ok);
        Assert.Contains("indésirables", failure.Error);
        Assert.Equal(0, _mail.Count("Junk")); // nettoyé aussi dans les indésirables

        var lenient = NewProbe();
        lenient.Email!.SpamIsFailure = false;
        var warning = await Run(lenient);
        Assert.True(warning.Ok);
        Assert.Contains("indésirables", warning.Warning);
    }

    [Fact]
    public async Task Late_messages_of_previous_runs_are_removed_but_not_other_mail()
    {
        _mail.Deposit("INBOX", "X-Wolflog-Probe: p1.ancien\r\nSubject: reste d'un essai\r\n\r\ncorps\r\n");
        _mail.Deposit("INBOX", "Subject: courrier de l'utilisateur\r\n\r\ncorps\r\n");
        var result = await Run(NewProbe());
        Assert.True(result.Ok, result.Error);
        Assert.Equal(1, _mail.Count("INBOX"));
    }

    [Fact]
    public void Stored_password_is_reused_only_for_the_same_server_and_account()
    {
        var saved = NewProbe();
        Assert.Null(saved.Email!.SmtpPassword);
        Assert.NotNull(saved.Email.ProtectedSmtpPassword);
        Assert.Equal(FakeMailServer.Password, _secrets.SmtpPassword(saved.Email));

        // Modification sans retaper le mot de passe : conservé.
        var edited = NewProbe(smtpPassword: null);
        _secrets.Prepare(edited, saved);
        Assert.Equal(FakeMailServer.Password, _secrets.SmtpPassword(edited.Email!));

        // Même sonde dirigée vers un autre serveur : le mot de passe n'y part pas sans être retapé.
        var redirected = NewProbe(smtpPassword: null);
        redirected.Email!.SmtpHost = "smtp.ailleurs.test";
        _secrets.Prepare(redirected, saved);
        Assert.Null(_secrets.SmtpPassword(redirected.Email));

        // Affichage : jamais de mot de passe, seulement l'indication qu'il y en a un.
        var shown = EmailProbeSecrets.ForDisplay(saved);
        Assert.Null(shown.Email!.ProtectedSmtpPassword);
        Assert.Null(shown.Email.SmtpPassword);
        Assert.True(shown.Email.HasSmtpPassword);
        Assert.NotNull(saved.Email.ProtectedSmtpPassword); // l'original n'est pas modifié
    }
}
