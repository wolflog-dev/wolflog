using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;

namespace Wolflog.Server.Security;

/// <summary>
/// Réglages de connexion unique (sso.json). Le secret client Microsoft et le mot de passe du compte de service LDAP sont
/// chiffrés par Data Protection, dont les clés restent dans le dossier de données (data-protection/) : ils n'apparaissent
/// ni dans le fichier, ni dans les sauvegardes de configuration, ni dans les réponses de l'API.
/// </summary>
public sealed class SsoSettingsStore(IOptions<WolflogServerOptions> o, IHostEnvironment env, IDataProtectionProvider protection, ILogger<SsoSettingsStore> log)
    : JsonCollection<SsoSettings>(o.Value.ResolveDataDirectory(env.ContentRootPath), "sso.json")
{
    /// <summary>Échec de connexion unique, montré à l'administrateur.</summary>
    public sealed record Failure(DateTime At, string Method, string Message);

    private readonly IDataProtector _secrets = protection.CreateProtector("Wolflog.Sso.ClientSecret");
    private readonly IDataProtector _bindPasswords = protection.CreateProtector("Wolflog.Sso.LdapBindPassword");

    public SsoSettings Current => Get(SsoSettings.DocumentId) ?? new SsoSettings();

    /// <summary>Dernier échec depuis le démarrage (connexion refusée, erreur de Microsoft, annuaire injoignable…).</summary>
    public Failure? LastFailure { get; private set; }

    public string ProtectSecret(string secret) => _secrets.Protect(secret);

    public string ProtectBindPassword(string password) => _bindPasswords.Protect(password);

    /// <summary>Secret client en clair ; null s'il manque ou s'il est illisible (clés de chiffrement perdues : à ressaisir).</summary>
    public string? ClientSecret(SsoSettings settings) => Unprotect(_secrets, settings.ProtectedClientSecret);

    /// <summary>Mot de passe du compte de service LDAP en clair ; null s'il manque ou s'il est illisible.</summary>
    public string? BindPassword(LdapSettings ldap) => Unprotect(_bindPasswords, ldap.ProtectedBindPassword);

    public void RecordFailure(string method, string message)
    {
        LastFailure = new Failure(DateTime.UtcNow, method, message);
        log.LogWarning("Connexion unique ({Method}) : {Message}", method, message);
    }

    private static string? Unprotect(IDataProtector protector, string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        try { return protector.Unprotect(value); }
        catch (CryptographicException) { return null; }
    }
}
