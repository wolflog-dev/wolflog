using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;

namespace Wolflog.Server.Monitoring;

/// <summary>
/// Mots de passe des sondes e-mail : chiffrés à l'enregistrement, jamais renvoyés à l'interface, déchiffrés au moment
/// de la vérification seulement.
/// </summary>
public sealed class EmailProbeSecrets(IDataProtectionProvider protection, MicrosoftMailTokens? microsoft = null)
{
    private readonly IDataProtector _protector = protection.CreateProtector("Wolflog.Probes.EmailPassword");

    /// <summary>
    /// Prépare une sonde reçue de l'interface : mots de passe saisis chiffrés ; champ vide = mot de passe enregistré
    /// conservé, mais seulement si le serveur et le compte n'ont pas changé (sinon, quelqu'un qui ne connaît pas le mot
    /// de passe pourrait le faire envoyer vers son propre serveur). Les valeurs chiffrées reçues sont ignorées.
    /// Connexion Microsoft : secret et compte connecté, voir <see cref="MicrosoftMailTokens.Prepare"/>.
    /// </summary>
    public void Prepare(Probe incoming, Probe? existing, string owner = "")
    {
        if (incoming.Type != "email" || incoming.Email is not { } e)
        {
            incoming.Email = null;
            return;
        }
        var old = existing?.Type == "email" ? existing.Email : null;
        if (e.Auth == "microsoft")
        {
            e.Microsoft ??= new MicrosoftMailAuth();
            if (microsoft is not null) microsoft.Prepare(e.Microsoft, old?.Microsoft, owner);
            else e.Microsoft.ProtectedClientSecret = e.Microsoft.ProtectedRefreshToken = null;
            e.ProtectedSmtpPassword = e.ProtectedImapPassword = null;
        }
        else
        {
            e.Auth = "password";
            e.Microsoft = null;
            e.ProtectedSmtpPassword = Keep(e.SmtpPassword, e.SmtpUser, e.SmtpHost, old?.ProtectedSmtpPassword, old?.SmtpUser, old?.SmtpHost);
            e.ProtectedImapPassword = Keep(e.ImapPassword, e.ImapUser, e.ImapHost, old?.ProtectedImapPassword, old?.ImapUser, old?.ImapHost);
        }
        e.SmtpPassword = e.ImapPassword = null;
        e.HasSmtpPassword = e.HasImapPassword = false;
        incoming.Target = $"{e.SmtpHost}:{e.SmtpPort} → {e.To}";
    }

    private string? Keep(string? typed, string? user, string? host, string? oldProtected, string? oldUser, string? oldHost)
    {
        if (string.IsNullOrWhiteSpace(user)) return null; // sans compte : sans mot de passe
        if (!string.IsNullOrEmpty(typed)) return _protector.Protect(typed);
        var same = string.Equals(user?.Trim(), oldUser?.Trim(), StringComparison.OrdinalIgnoreCase)
            && string.Equals(host?.Trim(), oldHost?.Trim(), StringComparison.OrdinalIgnoreCase);
        return same ? oldProtected : null;
    }

    /// <summary>Copie pour l'interface : aucun mot de passe, seulement s'il y en a un.</summary>
    public static Probe ForDisplay(Probe p)
    {
        if (p.Email is null) return p;
        var copy = p.Copy();
        var e = p.Email.Copy();
        e.HasSmtpPassword = !string.IsNullOrEmpty(e.ProtectedSmtpPassword);
        e.HasImapPassword = !string.IsNullOrEmpty(e.ProtectedImapPassword);
        e.ProtectedSmtpPassword = e.ProtectedImapPassword = e.SmtpPassword = e.ImapPassword = null;
        e.Microsoft = e.Microsoft is null ? null : MicrosoftMailTokens.ForDisplay(e.Microsoft);
        copy.Email = e;
        return copy;
    }

    public string? SmtpPassword(EmailProbeSettings e) => Unprotect(e.ProtectedSmtpPassword);

    public string? ImapPassword(EmailProbeSettings e) => Unprotect(e.ProtectedImapPassword);

    private string? Unprotect(string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        try { return _protector.Unprotect(value); }
        catch (CryptographicException) { return null; }
    }
}
