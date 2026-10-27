namespace Wolflog.Server.Monitoring;

/// <summary>
/// Connexion à une messagerie Microsoft (Microsoft 365, Outlook.com) en OAuth (SASL XOAUTH2), Microsoft refusant le mot de
/// passe en IMAP (et, de plus en plus, en SMTP). Deux modes :
/// <list type="bullet">
/// <item>account : le compte se connecte une fois (code à saisir sur microsoft.com/devicelogin), Wolflog garde un jeton de
/// renouvellement ;</item>
/// <item>app : application Entra ID (ID + secret), à qui l'administrateur Exchange a donné accès à la boîte.</item>
/// </list>
/// Secrets chiffrés (Protected…) par Data Protection, jamais renvoyés à l'interface.
/// </summary>
public sealed class MicrosoftMailAuth
{
    /// <summary>account ou app.</summary>
    public string Mode { get; set; } = "account";
    /// <summary>Annuaire : ID (GUID) ou domaine ; compte connecté : aussi « common », « organizations » ou « consumers ».</summary>
    public string? Tenant { get; set; }
    /// <summary>ID d'application (client) de l'inscription Entra ID.</summary>
    public string? ClientId { get; set; }

    /// <summary>Mode app. Saisie seulement : vide à l'enregistrement = secret déjà enregistré conservé (même application).</summary>
    public string? ClientSecret { get; set; }
    public string? ProtectedClientSecret { get; set; }
    /// <summary>Renvoyé à l'interface : un secret est enregistré.</summary>
    public bool HasClientSecret { get; set; }

    /// <summary>Mode account : adresse du compte connecté.</summary>
    public string? Account { get; set; }
    /// <summary>Saisie seulement : connexion qui vient d'aboutir (code saisi chez Microsoft), à rattacher à l'enregistrement.</summary>
    public string? ConnectionId { get; set; }
    public string? ProtectedRefreshToken { get; set; }
    /// <summary>Renvoyé à l'interface : un compte est connecté.</summary>
    public bool Connected { get; set; }

    public MicrosoftMailAuth Copy() => (MicrosoftMailAuth)MemberwiseClone();
}
