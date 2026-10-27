namespace Wolflog.Server.Monitoring;

/// <summary>
/// Sonde e-mail : envoi d'un message de test par SMTP, puis (si une boîte est renseignée) vérification de sa réception
/// par IMAP. Les mots de passe ne sont jamais enregistrés ni renvoyés en clair : saisis dans SmtpPassword / ImapPassword,
/// ils sont chiffrés dans les champs Protected… (Data Protection, clés dans le dossier de données).
/// </summary>
public sealed class EmailProbeSettings
{
    /// <summary>
    /// Connexion : password (identifiant et mot de passe) ou microsoft (OAuth, voir <see cref="Microsoft"/>, pour l'envoi
    /// et la réception).
    /// </summary>
    public string Auth { get; set; } = "password";
    public MicrosoftMailAuth? Microsoft { get; set; }

    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 587;
    /// <summary>auto, starttls (obligatoire), ssl (dès la connexion, port 465) ou none.</summary>
    public string SmtpSecurity { get; set; } = "auto";
    public string? SmtpUser { get; set; }
    /// <summary>Saisie seulement : vide à l'enregistrement = mot de passe déjà enregistré conservé.</summary>
    public string? SmtpPassword { get; set; }
    public string? ProtectedSmtpPassword { get; set; }
    /// <summary>Renvoyé à l'interface : un mot de passe SMTP est enregistré.</summary>
    public bool HasSmtpPassword { get; set; }

    /// <summary>Expéditeur et destinataire du message de test.</summary>
    public string From { get; set; } = "";
    public string To { get; set; } = "";

    /// <summary>Boîte de réception (IMAP) ; vide : seul l'envoi est vérifié.</summary>
    public string? ImapHost { get; set; }
    public int ImapPort { get; set; } = 993;
    /// <summary>ssl (port 993), starttls, auto ou none.</summary>
    public string ImapSecurity { get; set; } = "ssl";
    public string? ImapUser { get; set; }
    public string? ImapPassword { get; set; }
    public string? ProtectedImapPassword { get; set; }
    public bool HasImapPassword { get; set; }
    /// <summary>Dossier où le message doit arriver.</summary>
    public string Folder { get; set; } = "INBOX";
    /// <summary>Délai maximal d'arrivée du message (secondes).</summary>
    public int DeliveryTimeoutSeconds { get; set; } = 180;
    /// <summary>Message arrivé dans les indésirables : échec (true) ou simple avertissement.</summary>
    public bool SpamIsFailure { get; set; } = true;

    public bool ChecksDelivery => !string.IsNullOrWhiteSpace(ImapHost);

    public bool UsesMicrosoft => Auth == "microsoft" && Microsoft is not null;

    public EmailProbeSettings Copy()
    {
        var copy = (EmailProbeSettings)MemberwiseClone();
        copy.Microsoft = Microsoft?.Copy();
        return copy;
    }
}
