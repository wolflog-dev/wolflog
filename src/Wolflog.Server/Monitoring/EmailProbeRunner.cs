using System.Diagnostics;
using MailKit;
using MailKit.Net.Imap;
using MimeKit;
using MailSearch = MailKit.Search.SearchQuery;
using SmtpClient = MailKit.Net.Smtp.SmtpClient;

namespace Wolflog.Server.Monitoring;

/// <summary>
/// Vérification de bout en bout de la messagerie : envoi d'un message marqué (en-tête X-Wolflog-Probe) par SMTP, puis
/// recherche de ce message dans la boîte IMAP jusqu'à son arrivée (dossier choisi, puis indésirables). Chaque étape est
/// chronométrée ; le message est supprimé dès qu'il est trouvé, ainsi que ceux d'essais précédents arrivés en retard.
/// </summary>
public sealed class EmailProbeRunner(EmailProbeSecrets secrets, ILogger<EmailProbeRunner> log)
{
    public const string Header = "X-Wolflog-Probe";

    /// <summary>Noms courants du dossier des indésirables, quand le serveur ne l'annonce pas (SPECIAL-USE).</summary>
    private static readonly string[] JunkNames = ["Junk", "Spam", "Junk E-mail", "Junk Email", "Courrier indésirable", "Indésirables", "Bulk Mail", "[Gmail]/Spam"];

    /// <summary>Intervalle entre deux recherches du message dans la boîte.</summary>
    internal static TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    /// <summary>Délai d'arrivée minimal accepté (réduit dans les tests).</summary>
    internal static int MinimumDeliveryTimeoutSeconds = 15;

    public async Task<ProbeResult> RunAsync(Probe p, CancellationToken ct)
    {
        var e = p.Email ?? throw new InvalidOperationException("Sonde e-mail sans réglages.");
        var at = DateTime.UtcNow;
        var steps = new List<ProbeStep>();
        int? certDays = null;
        void Cert(int days) => certDays = certDays is { } d ? Math.Min(d, days) : days;
        var timeoutMs = Math.Clamp(p.TimeoutSeconds, 5, 120) * 1000;
        // Clé de la sonde dans l'en-tête : retrouve aussi les messages d'essais précédents (« essai » : sonde non enregistrée).
        var key = string.IsNullOrEmpty(p.Id) ? "essai" : p.Id;
        var tag = $"{key}.{Guid.NewGuid():N}";

        ProbeResult Fail(string step, Exception ex)
        {
            var reason = MailTransport.Describe(ex);
            log.LogDebug(ex, "Sonde e-mail {Name} : {Step}", p.Name, step);
            return new ProbeResult(at, false, steps.Sum(s => s.DurationMs), null, $"{step} : {reason}", certDays, steps);
        }

        async Task<string?> Step(string name, Func<Task<string?>> action)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                var detail = await action();
                steps.Add(new ProbeStep(name, true, sw.Elapsed.TotalMilliseconds, detail));
                return detail;
            }
            catch (Exception ex) when (MailTransport.IsMailError(ex) || ex is OperationCanceledException && !ct.IsCancellationRequested)
            {
                steps.Add(new ProbeStep(name, false, sw.Elapsed.TotalMilliseconds, MailTransport.Describe(ex)));
                throw new StepFailedException(name, ex);
            }
        }

        // ------------------------------------------------------------ envoi
        DateTime sentAt;
        var sendWatch = Stopwatch.StartNew();
        try
        {
            using var smtp = new SmtpClient { Timeout = timeoutMs, ServerCertificateValidationCallback = MailTransport.Validate(p.IgnoreTlsErrors, Cert) };
            await Step("Connexion SMTP", async () =>
            {
                await smtp.ConnectAsync(e.SmtpHost.Trim(), e.SmtpPort, MailTransport.Options(e.SmtpSecurity, e.SmtpPort), ct);
                return $"{e.SmtpHost}:{e.SmtpPort}, " + (smtp.IsSecure ? $"chiffrée ({smtp.SslProtocol})" : "non chiffrée");
            });
            if (!string.IsNullOrWhiteSpace(e.SmtpUser))
            {
                await Step("Authentification SMTP", async () =>
                {
                    await smtp.AuthenticateAsync(e.SmtpUser.Trim(), secrets.SmtpPassword(e) ?? "", ct);
                    return e.SmtpUser.Trim();
                });
            }
            var message = Compose(p, e, tag);
            await Step("Envoi", async () =>
            {
                var response = await smtp.SendAsync(message, ct);
                return string.IsNullOrWhiteSpace(response) ? "accepté par le serveur" : "accepté : " + Shorten(response, 140);
            });
            sentAt = DateTime.UtcNow;
            try { await smtp.DisconnectAsync(true, ct); }
            catch (Exception ex) when (MailTransport.IsMailError(ex)) { /* message déjà accepté */ }
        }
        catch (StepFailedException f)
        {
            return Fail(f.Step, f.InnerException!);
        }
        var sendMs = sendWatch.Elapsed.TotalMilliseconds;
        if (!e.ChecksDelivery) return new ProbeResult(at, true, sendMs, null, null, certDays, steps);

        // ------------------------------------------------------------ réception
        try
        {
            using var imap = new ImapClient { Timeout = timeoutMs, ServerCertificateValidationCallback = MailTransport.Validate(p.IgnoreTlsErrors, Cert) };
            await Step("Connexion IMAP", async () =>
            {
                await imap.ConnectAsync(e.ImapHost!.Trim(), e.ImapPort, MailTransport.Options(e.ImapSecurity, e.ImapPort), ct);
                return $"{e.ImapHost}:{e.ImapPort}, " + (imap.IsSecure ? $"chiffrée ({imap.SslProtocol})" : "non chiffrée");
            });
            await Step("Authentification IMAP", async () =>
            {
                await imap.AuthenticateAsync((e.ImapUser ?? e.SmtpUser ?? "").Trim(), secrets.ImapPassword(e) ?? "", ct);
                return (e.ImapUser ?? e.SmtpUser ?? "").Trim();
            });
            var folder = string.IsNullOrWhiteSpace(e.Folder) || e.Folder.Equals("INBOX", StringComparison.OrdinalIgnoreCase)
                ? imap.Inbox : await imap.GetFolderAsync(e.Folder.Trim(), ct);
            var junk = await JunkFolderAsync(imap, folder, ct);

            var waited = Stopwatch.StartNew();
            var limit = TimeSpan.FromSeconds(Math.Clamp(e.DeliveryTimeoutSeconds, MinimumDeliveryTimeoutSeconds, 1800));
            (IMailFolder Folder, DateTime ArrivedAt)? found = null;
            while (found is null && waited.Elapsed < limit)
            {
                await imap.NoOpAsync(ct);
                found = await FindAsync(folder, tag, sentAt, ct) is { } inBox ? (folder, inBox)
                    : junk is not null && await FindAsync(junk, tag, sentAt, ct) is { } inJunk ? (junk, inJunk) : null;
                if (found is null) await Task.Delay(PollInterval, ct);
            }

            // Nettoyage : ce message et ceux d'essais précédents de la même sonde (arrivés après un dépassement de délai).
            var uidPlus = (imap.Capabilities & ImapCapabilities.UidPlus) != 0;
            foreach (var f in new[] { folder, junk }.OfType<IMailFolder>()) await CleanUpAsync(f, key, uidPlus, ct);
            try { await imap.DisconnectAsync(true, ct); }
            catch (Exception ex) when (MailTransport.IsMailError(ex)) { }

            if (found is not { } hit)
            {
                steps.Add(new ProbeStep("Réception", false, waited.Elapsed.TotalMilliseconds, $"non arrivé après {Human(limit)}"));
                return new ProbeResult(at, false, waited.Elapsed.TotalMilliseconds, null,
                    $"Réception : message non arrivé après {Human(limit)} (envoi pourtant accepté par le serveur SMTP)", certDays, steps);
            }
            var delay = Math.Max(0, (hit.ArrivedAt - sentAt).TotalMilliseconds) + sendMs;
            var inJunkFolder = junk is not null && hit.Folder == junk;
            steps.Add(new ProbeStep("Réception", !inJunkFolder || !e.SpamIsFailure, delay,
                inJunkFolder ? $"arrivé dans les indésirables ({junk!.FullName})" : $"arrivé dans {hit.Folder.FullName}"));
            if (!inJunkFolder) return new ProbeResult(at, true, delay, null, null, certDays, steps);
            var spam = $"Message arrivé dans les courriers indésirables ({junk!.FullName}) : vérifiez SPF, DKIM et DMARC du domaine expéditeur";
            return e.SpamIsFailure
                ? new ProbeResult(at, false, delay, null, spam, certDays, steps)
                : new ProbeResult(at, true, delay, null, null, certDays, steps, spam);
        }
        catch (StepFailedException f)
        {
            return Fail(f.Step, f.InnerException!);
        }
        catch (Exception ex) when (MailTransport.IsMailError(ex) || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            return Fail("Réception", ex);
        }
    }

    private static MimeMessage Compose(Probe p, EmailProbeSettings e, string tag)
    {
        var message = new MimeMessage();
        message.From.Add(MailboxAddress.Parse(e.From.Trim()));
        message.To.Add(MailboxAddress.Parse(e.To.Trim()));
        message.Subject = $"[Wolflog] Test de messagerie : {p.Name}";
        message.Headers.Add(Header, tag);
        message.Headers.Add("Auto-Submitted", "auto-generated");
        message.Body = new TextPart("plain")
        {
            Text = $"Message de test envoyé par la sonde « {p.Name} » de Wolflog pour vérifier l'envoi et la réception des e-mails.\n"
                + "Il est supprimé automatiquement dès son arrivée ; vous pouvez l'ignorer.\n\n"
                + $"Identifiant : {tag}\n",
        };
        return message;
    }

    /// <summary>Date d'arrivée du message marqué, ou null s'il n'est pas (encore) là.</summary>
    private static async Task<DateTime?> FindAsync(IMailFolder folder, string tag, DateTime sentAt, CancellationToken ct)
    {
        if (!folder.IsOpen || folder.Access != FolderAccess.ReadWrite) await folder.OpenAsync(FolderAccess.ReadWrite, ct);
        var uids = await folder.SearchAsync(MailSearch.HeaderContains(Header, tag), ct);
        if (uids.Count == 0) return null;
        // Arrivée : date de réception du serveur, à la seconde près (tronquée) ; la plus tardive possible (date + 1 s,
        // sans dépasser l'instant où le message a été trouvé), pour ne jamais sous-estimer le délai. Date incohérente
        // (horloge du serveur décalée) : l'instant où il a été trouvé.
        var summary = (await folder.FetchAsync(uids, MessageSummaryItems.InternalDate, ct)).FirstOrDefault();
        var internalDate = summary?.InternalDate?.UtcDateTime;
        var now = DateTime.UtcNow;
        if (internalDate is not { } d || d < sentAt.AddMinutes(-1) || d > now) return now;
        var latest = d.AddSeconds(1) < now ? d.AddSeconds(1) : now;
        return latest < sentAt ? sentAt : latest;
    }

    private async Task CleanUpAsync(IMailFolder folder, string key, bool uidPlus, CancellationToken ct)
    {
        try
        {
            if (!folder.IsOpen || folder.Access != FolderAccess.ReadWrite) await folder.OpenAsync(FolderAccess.ReadWrite, ct);
            var uids = await folder.SearchAsync(MailSearch.HeaderContains(Header, key + "."), ct);
            if (uids.Count == 0) return;
            await folder.AddFlagsAsync(uids, MessageFlags.Deleted, true, ct);
            // UIDPLUS : seuls ces messages sont effacés définitivement ; sinon, tout ce qui est marqué supprimé dans le dossier.
            if (uidPlus) await folder.ExpungeAsync(uids, ct);
            else await folder.ExpungeAsync(ct);
        }
        catch (Exception ex) when (MailTransport.IsMailError(ex))
        {
            log.LogDebug(ex, "Sonde e-mail : nettoyage de {Folder} impossible", folder.FullName);
        }
    }

    /// <summary>Dossier des indésirables : annoncé par le serveur (SPECIAL-USE), sinon trouvé par son nom.</summary>
    private static async Task<IMailFolder?> JunkFolderAsync(ImapClient imap, IMailFolder target, CancellationToken ct)
    {
        try
        {
            if ((imap.Capabilities & (ImapCapabilities.SpecialUse | ImapCapabilities.XList)) != 0 && imap.GetFolder(SpecialFolder.Junk) is { } special)
                return special.FullName == target.FullName ? null : special;
        }
        catch (Exception ex) when (MailTransport.IsMailError(ex)) { }
        try
        {
            var root = imap.GetFolder(imap.PersonalNamespaces[0]);
            // Tous les dossiers (false), pas seulement ceux auxquels le compte est abonné.
            foreach (var folder in await root.GetSubfoldersAsync(false, ct))
            {
                if (JunkNames.Contains(folder.Name, StringComparer.OrdinalIgnoreCase) && folder.FullName != target.FullName) return folder;
                foreach (var sub in await folder.GetSubfoldersAsync(false, ct))
                    if (JunkNames.Contains(sub.FullName, StringComparer.OrdinalIgnoreCase) || JunkNames.Contains(sub.Name, StringComparer.OrdinalIgnoreCase))
                        return sub.FullName == target.FullName ? null : sub;
            }
        }
        catch (Exception ex) when (MailTransport.IsMailError(ex)) { }
        return null;
    }

    private static string Shorten(string s, int max)
    {
        s = s.ReplaceLineEndings(" ").Trim();
        return s.Length <= max ? s : s[..(max - 1)] + "…";
    }

    private static string Human(TimeSpan t) => t.TotalMinutes >= 1 ? $"{t.TotalMinutes:0.#} min".Replace('.', ',') : $"{t.TotalSeconds:0} s";

    /// <summary>Échec d'une étape (l'étape est déjà ajoutée à la liste).</summary>
    private sealed class StepFailedException(string step, Exception inner) : Exception(step, inner)
    {
        public string Step { get; } = step;
    }
}
