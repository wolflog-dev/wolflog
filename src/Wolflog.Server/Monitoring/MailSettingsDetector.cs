using System.Net.Sockets;

namespace Wolflog.Server.Monitoring;

/// <summary>
/// Réglages d'une messagerie à partir de l'adresse seule, comme Outlook ou Thunderbird : domaine connu, sinon hébergeur
/// reconnu dans le DNS (MX, puis SPF quand une passerelle antispam est devant), sinon enregistrements SRV (RFC 6186),
/// sinon noms courants (smtp., mail., imap.) essayés sur les ports habituels.
/// </summary>
public sealed class MailSettingsDetector(MailDns dns)
{
    public sealed record Server(string Host, int Port, string Security);

    /// <summary>
    /// Provider : microsoft365, outlook, google, … other (serveur trouvé), unknown (rien trouvé). Auth : password,
    /// app-password (mot de passe d'application exigé) ou microsoft (OAuth). Evidence : d'où vient la conclusion.
    /// </summary>
    public sealed record Result(string Provider, string Label, Server? Smtp, Server? Imap, string Auth, string? Evidence, List<string> Notes);

    private sealed record Provider(string Id, string Label, Server Smtp, Server Imap, string Auth = "password", string? Note = null);

    private const string MicrosoftNote =
        "Microsoft 365 refuse le mot de passe pour lire une boîte (IMAP), et de plus en plus pour envoyer : choisissez la connexion « Compte Microsoft ».";

    private static readonly Provider Microsoft365 = new("microsoft365", "Microsoft 365",
        new("smtp.office365.com", 587, "starttls"), new("outlook.office365.com", 993, "ssl"), "microsoft", MicrosoftNote);
    private static readonly Provider OutlookCom = new("outlook", "Outlook.com",
        new("smtp-mail.outlook.com", 587, "starttls"), new("outlook.office365.com", 993, "ssl"), "microsoft",
        "Outlook.com n'accepte plus le mot de passe en SMTP ni en IMAP : choisissez la connexion « Compte Microsoft ».");
    private static readonly Provider Google = new("google", "Google (Gmail, Workspace)",
        new("smtp.gmail.com", 587, "starttls"), new("imap.gmail.com", 993, "ssl"), "app-password",
        "Google demande un mot de passe d'application (Compte Google > Sécurité > Validation en deux étapes > Mots de passe des applications).");
    private static readonly Provider Ovh = new("ovh", "OVHcloud", new("ssl0.ovh.net", 465, "ssl"), new("ssl0.ovh.net", 993, "ssl"));
    private static readonly Provider Hostinger = new("hostinger", "Hostinger", new("smtp.hostinger.com", 465, "ssl"), new("imap.hostinger.com", 993, "ssl"));
    private static readonly Provider Gandi = new("gandi", "Gandi", new("mail.gandi.net", 465, "ssl"), new("mail.gandi.net", 993, "ssl"));
    private static readonly Provider Infomaniak = new("infomaniak", "Infomaniak", new("mail.infomaniak.com", 465, "ssl"), new("mail.infomaniak.com", 993, "ssl"));
    private static readonly Provider Ionos = new("ionos", "IONOS", new("smtp.ionos.fr", 465, "ssl"), new("imap.ionos.fr", 993, "ssl"));
    private static readonly Provider Zoho = new("zoho", "Zoho Mail", new("smtp.zoho.eu", 465, "ssl"), new("imap.zoho.eu", 993, "ssl"), "app-password",
        "Zoho demande un mot de passe d'application si la validation en deux étapes est active.");
    private static readonly Provider GoDaddy = new("godaddy", "GoDaddy", new("smtpout.secureserver.net", 465, "ssl"), new("imap.secureserver.net", 993, "ssl"));
    private static readonly Provider ICloud = new("icloud", "iCloud", new("smtp.mail.me.com", 587, "starttls"), new("imap.mail.me.com", 993, "ssl"), "app-password",
        "Apple demande un mot de passe pour app (appleid.apple.com > Connexion et sécurité).");
    private static readonly Provider Yahoo = new("yahoo", "Yahoo", new("smtp.mail.yahoo.com", 465, "ssl"), new("imap.mail.yahoo.com", 993, "ssl"), "app-password",
        "Yahoo demande un mot de passe d'application (Sécurité du compte).");
    private static readonly Provider Orange = new("orange", "Orange", new("smtp.orange.fr", 465, "ssl"), new("imap.orange.fr", 993, "ssl"));
    private static readonly Provider Free = new("free", "Free", new("smtp.free.fr", 465, "ssl"), new("imap.free.fr", 993, "ssl"));
    private static readonly Provider Sfr = new("sfr", "SFR", new("smtp.sfr.fr", 465, "ssl"), new("imap.sfr.fr", 993, "ssl"));
    private static readonly Provider LaPoste = new("laposte", "La Poste", new("smtp.laposte.net", 465, "ssl"), new("imap.laposte.net", 993, "ssl"));

    /// <summary>Adresses grand public : domaine de l'adresse.</summary>
    private static readonly Dictionary<string, Provider> Domains = new(StringComparer.OrdinalIgnoreCase)
    {
        ["gmail.com"] = Google, ["googlemail.com"] = Google,
        ["outlook.com"] = OutlookCom, ["outlook.fr"] = OutlookCom, ["hotmail.com"] = OutlookCom, ["hotmail.fr"] = OutlookCom,
        ["live.com"] = OutlookCom, ["live.fr"] = OutlookCom, ["msn.com"] = OutlookCom,
        ["icloud.com"] = ICloud, ["me.com"] = ICloud, ["mac.com"] = ICloud,
        ["yahoo.com"] = Yahoo, ["yahoo.fr"] = Yahoo,
        ["orange.fr"] = Orange, ["wanadoo.fr"] = Orange, ["free.fr"] = Free, ["sfr.fr"] = Sfr, ["neuf.fr"] = Sfr, ["laposte.net"] = LaPoste,
    };

    /// <summary>Hébergeur d'après ses serveurs MX (suffixe).</summary>
    private static readonly (string Suffix, Provider Provider)[] MxSuffixes =
    [
        ("mail.protection.outlook.com", Microsoft365), ("olc.protection.outlook.com", OutlookCom),
        ("google.com", Google), ("googlemail.com", Google),
        ("ovh.net", Ovh), ("hostinger.com", Hostinger), ("gandi.net", Gandi), ("infomaniak.ch", Infomaniak), ("ik-mail.com", Infomaniak),
        ("ionos.fr", Ionos), ("ionos.com", Ionos), ("ionos.de", Ionos), ("kundenserver.de", Ionos),
        ("zoho.eu", Zoho), ("zoho.com", Zoho), ("secureserver.net", GoDaddy), ("icloud.com", ICloud),
    ];

    /// <summary>Hébergeur d'après le SPF (inclusion), utile quand une passerelle antispam reçoit le courrier à sa place.</summary>
    private static readonly (string Include, Provider Provider)[] SpfIncludes =
    [
        ("spf.protection.outlook.com", Microsoft365), ("_spf.google.com", Google), ("mx.ovh.com", Ovh), ("spf.ovh.net", Ovh),
        ("_spf.mail.hostinger.com", Hostinger), ("_mailcust.gandi.net", Gandi), ("spf.infomaniak.ch", Infomaniak),
        ("_spf-eu.ionos.com", Ionos), ("_spf.perfora.net", Ionos), ("zoho.eu", Zoho), ("zoho.com", Zoho), ("secureserver.net", GoDaddy),
    ];

    /// <summary>Passerelles antispam : le MX ne dit pas où est la boîte.</summary>
    private static readonly string[] Gateways =
        ["mimecast.com", "pphosted.com", "ppe-hosted.com", "mailinblack.com", "vadesecure.com", "barracudanetworks.com", "messagelabs.com",
         "iphmx.com", "mailcontrol.com", "altospam.com", "trendmicro.eu", "trendmicro.com", "sophos.com", "hornetsecurity.com", "spamexperts.com"];

    /// <summary>Délai d'un essai de connexion (noms courants).</summary>
    internal static TimeSpan ConnectTimeout = TimeSpan.FromSeconds(3);

    public async Task<Result> DetectAsync(string address, CancellationToken ct)
    {
        var domain = MimeKit.MailboxAddress.TryParse(address?.Trim() ?? "", out var mailbox) ? mailbox.Domain.Trim().ToLowerInvariant() : "";
        if (domain.Length == 0 || !domain.Contains('.')) return new("unknown", "Adresse invalide", null, null, "password", null, ["Saisissez une adresse complète (nom@domaine)."]);
        if (Domains.TryGetValue(domain, out var known)) return Found(known, $"adresse {domain}");

        var mx = (await dns.QueryAsync(domain, MailDns.Mx, ct)).OrderBy(r => r.Priority).ToList();
        foreach (var r in mx)
            if (MxSuffixes.FirstOrDefault(s => EndsWith(r.Value, s.Suffix)) is { Provider: { } p })
                return Found(p, $"MX : {r.Value}");

        // SPF et enregistrements SRV (RFC 6186 : le domaine annonce ses serveurs), demandés ensemble.
        var txt = dns.QueryAsync(domain, MailDns.Txt, ct);
        var srv = new[] { ("_submissions", "ssl"), ("_submission", "starttls"), ("_imaps", "ssl"), ("_imap", "starttls") }
            .Select(s => SrvAsync($"{s.Item1}._tcp.{domain}", s.Item2, ct)).ToArray();
        await Task.WhenAll(srv.Cast<Task>().Append(txt));

        var gateway = mx.Select(r => r.Value).FirstOrDefault(h => Gateways.Any(g => EndsWith(h, g)));
        var spf = txt.Result.Select(r => r.Value).FirstOrDefault(t => t.StartsWith("v=spf1", StringComparison.OrdinalIgnoreCase));
        if (spf is not null)
            foreach (var (include, p) in SpfIncludes)
                if (spf.Contains("include:" + include, StringComparison.OrdinalIgnoreCase))
                    return Found(p, $"SPF : include:{include}{(gateway is null ? "" : $" (courrier reçu par la passerelle {gateway})")}");

        var smtp = srv[0].Result ?? srv[1].Result;
        var imap = srv[2].Result ?? srv[3].Result;
        if (smtp is not null || imap is not null)
            return new("other", "Serveur de l'entreprise", smtp, imap, "password", "SRV", []);

        // Noms courants, essayés sur les ports habituels.
        var smtpGuess = FirstOpenAsync(Candidates(["smtp", "mail", "smtp.mail"], domain).Concat(mx.Select(r => r.Value)), [(465, "ssl"), (587, "starttls")], ct);
        var imapGuess = FirstOpenAsync(Candidates(["imap", "mail", "imap.mail"], domain).Concat(mx.Select(r => r.Value)), [(993, "ssl"), (143, "starttls")], ct);
        smtp = await smtpGuess;
        imap = await imapGuess;
        if (smtp is not null || imap is not null)
            return new("other", "Serveur de l'entreprise", smtp, imap, "password", "noms courants",
                gateway is null ? [] : [$"Le courrier passe par la passerelle {gateway} : vérifiez les serveurs auprès de votre service informatique."]);

        var notes = new List<string> { "Hébergeur non reconnu : demandez à votre service informatique les serveurs SMTP (envoi) et IMAP (réception)." };
        if (gateway is not null) notes.Add($"Le courrier est reçu par la passerelle {gateway}, qui ne dit pas où se trouve la boîte.");
        return new("unknown", "Hébergeur non reconnu", null, null, "password", mx.Count > 0 ? $"MX : {mx[0].Value}" : null, notes);
    }

    private static Result Found(Provider p, string evidence) =>
        new(p.Id, p.Label, p.Smtp, p.Imap, p.Auth, evidence, p.Note is null ? [] : [p.Note]);

    private static bool EndsWith(string host, string suffix) =>
        host.Equals(suffix, StringComparison.OrdinalIgnoreCase) || host.EndsWith("." + suffix, StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<string> Candidates(string[] prefixes, string domain) => prefixes.Select(p => $"{p}.{domain}");

    private async Task<Server?> SrvAsync(string name, string security, CancellationToken ct)
    {
        var record = (await dns.QueryAsync(name, MailDns.Srv, ct)).Where(r => r.Value is not ("" or ".")).OrderBy(r => r.Priority).ThenByDescending(r => r.Weight).FirstOrDefault();
        return record is null ? null : new Server(record.Value, record.Port, security);
    }

    /// <summary>Premier couple hôte / port qui accepte une connexion (essais en parallèle, ordre de préférence conservé).</summary>
    private static async Task<Server?> FirstOpenAsync(IEnumerable<string> hosts, (int Port, string Security)[] ports, CancellationToken ct)
    {
        var candidates = hosts.Distinct(StringComparer.OrdinalIgnoreCase).SelectMany(h => ports.Select(p => new Server(h, p.Port, p.Security))).ToList();
        var checks = candidates.Select(c => OpenAsync(c, ct)).ToList();
        var results = await Task.WhenAll(checks);
        return candidates.Where((_, i) => results[i]).FirstOrDefault();
    }

    private static async Task<bool> OpenAsync(Server s, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(ConnectTimeout);
        try
        {
            using var tcp = new TcpClient();
            await tcp.ConnectAsync(s.Host, s.Port, timeout.Token);
            return true;
        }
        catch (Exception ex) when (ex is SocketException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            return false;
        }
    }
}
