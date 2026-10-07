using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Negotiate;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Hosting.Server;

namespace Wolflog.Server.Security;

/// <summary>
/// Schémas de la connexion unique réglée dans l'interface (« microsoft », « windows »), ajoutés ou retirés à chaud, sans
/// redémarrage. Jamais inscrits incomplets (leur validation ferait échouer chaque requête) ; leurs options en cache sont
/// oubliées à chaque changement (locataire, secret…). Décrit aussi les méthodes proposées sur la page de connexion.
/// </summary>
public sealed class SsoSchemes(IAuthenticationSchemeProvider schemes, IOptionsMonitorCache<OpenIdConnectOptions> oidcOptions,
    IOptionsMonitorCache<NegotiateOptions> negotiateOptions, SsoSettingsStore store, AuthService auth, ILogger<SsoSchemes> log)
{
    public const string Microsoft = "microsoft";
    public const string Windows = "windows";

    /// <summary>Posé à la déconnexion : la page de connexion ne repart pas aussitôt vers Microsoft ou Windows.</summary>
    public const string SignedOutCookie = "wolflog.signedout";

    /// <summary>Prise en charge de l'authentification Windows par le serveur web.</summary>
    /// <param name="Supported">Le serveur sait authentifier les sessions Windows.</param>
    /// <param name="Host">iis, kestrel ou none.</param>
    /// <param name="Message">Explication pour l'administrateur.</param>
    public sealed record HostSupport(bool Supported, string Host, string Message);

    /// <summary>Bibliothèque GSSAPI chargée par .NET pour Negotiate sous Linux (paquet libgssapi-krb5-2, ou krb5-libs).</summary>
    public const string GssapiLibrary = "libgssapi_krb5.so.2";

    private readonly Lock _lock = new();
    // Linux : vérification gardée une minute (elle a lieu à chaque requête de connexion), refaite ensuite pour voir un keytab ajouté.
    private static (DateTime At, HostSupport Support)? _linux;
    // Réglages appliqués : empreinte du schéma « microsoft » (null : absent), présence du schéma « windows ».
    private volatile string? _microsoft;
    private volatile bool _windows;

    public bool MicrosoftActive => _microsoft is not null;
    public bool WindowsActive => _windows;

    /// <summary>Schéma OpenID Connect proposé : « oidc » (wolflog.json, prioritaire), « microsoft » (interface), ou null.</summary>
    public string? OidcScheme => auth.Oidc is not null ? SessionPrincipal.OidcScheme : MicrosoftActive ? Microsoft : null;

    /// <summary>Applique les réglages enregistrés (après un enregistrement, une restauration ou une modification du fichier).</summary>
    public void Sync(HttpContext ctx)
    {
        var s = store.Current;
        var microsoft = auth.Oidc is null && s.MicrosoftEnabled && SsoSettings.TenantError(s.Tenant) is null
                        && Guid.TryParse(s.ClientId, out _) && store.ClientSecret(s) is not null
            ? string.Join('\n', s.Tenant, s.ClientId, s.ProtectedClientSecret)
            : null;
        var windows = s.WindowsEnabled && WindowsSupport(ctx).Supported;
        if (microsoft == _microsoft && windows == _windows) return;
        lock (_lock)
        {
            if (microsoft != _microsoft)
            {
                schemes.RemoveScheme(Microsoft);
                oidcOptions.TryRemove(Microsoft);
                if (microsoft is not null) schemes.TryAddScheme(new AuthenticationScheme(Microsoft, s.ButtonLabel, typeof(OpenIdConnectHandler)));
                _microsoft = microsoft;
                if (microsoft is null) log.LogInformation("Connexion Microsoft inactive.");
                else log.LogInformation("Connexion Microsoft active (locataire {Tenant}).", s.Tenant);
            }
            if (windows != _windows)
            {
                schemes.RemoveScheme(Windows);
                negotiateOptions.TryRemove(Windows);
                if (windows) schemes.TryAddScheme(new AuthenticationScheme(Windows, "Windows", typeof(NegotiateHandler)));
                _windows = windows;
                log.LogInformation("Connexion Windows {State}.", windows ? "active" : "inactive");
            }
        }
    }

    /// <summary>Méthodes proposées sur la page de connexion (null : aucune connexion unique ni annuaire).</summary>
    public object? Describe(HttpContext ctx)
    {
        var s = store.Current;
        var file = auth.Oidc;
        var oidc = OidcScheme is not null;
        var windows = WindowsActive;
        var ldap = s.Ldap is { Enabled: true } directory && directory.IsComplete();
        if (!oidc && !windows && !ldap) return null;
        var microsoft = oidc && (file is null || OidcSignIn.IsMicrosoft(file.Authority));
        var label = file is not null ? file.DisplayName : s.ButtonLabel;
        var ldapLabel = string.IsNullOrWhiteSpace(s.Ldap.Label) ? null : s.Ldap.Label.Trim();
        // Après une déconnexion, pas de connexion automatique : elle reconnecterait aussitôt la personne.
        var auto = ctx.Request.Cookies.ContainsKey(SignedOutCookie) ? null : s.AutoSignIn switch
        {
            Microsoft when oidc => Microsoft,
            Windows when windows => Windows,
            _ => null,
        };
        return new
        {
            name = oidc ? (string.IsNullOrWhiteSpace(label) ? "Microsoft" : label)
                : windows ? "Windows"
                : ldapLabel is null ? "l'annuaire de l'entreprise" : $"l'annuaire {ldapLabel}",
            microsoft,
            oidc = oidc && !microsoft,
            windows,
            // Annuaire LDAP / Active Directory : le formulaire accepte l'identifiant de l'entreprise (suffixe UPN pour l'exemple).
            ldap,
            ldapLabel = ldap ? ldapLabel : null,
            ldapDomain = ldap && !string.IsNullOrWhiteSpace(s.Ldap.UpnSuffix) ? s.Ldap.UpnSuffix.Trim().TrimStart('@') : null,
            autoRedirect = auto,
        };
    }

    /// <summary>
    /// Le serveur web sait-il authentifier les sessions Windows ? Sous IIS, l'authentification Windows du site doit être
    /// activée (Wolflog s'en remet alors à IIS) ; avec Kestrel (service Windows, Linux), Wolflog négocie lui-même.
    /// </summary>
    public static HostSupport WindowsSupport(HttpContext ctx)
    {
        if (ctx.RequestServices.GetServices<IServerIntegratedAuth>().LastOrDefault() is { } iis)
            return iis.IsEnabled
                ? new(true, "iis", "IIS : l'authentification Windows du site est activée, Wolflog s'appuie sur elle.")
                : new(false, "iis", "IIS : l'authentification Windows du site est désactivée. Activez-la (en laissant l'authentification anonyme activée), puis redémarrez le site.");
        if (ctx.Features.Get<IConnectionItemsFeature>() is null)
            return new(false, "none", "Ce serveur web ne gère pas l'authentification Windows : utilisez le service Windows (Kestrel) ou IIS.");
        if (!OperatingSystem.IsWindows())
        {
            if (_linux is { } cached && DateTime.UtcNow - cached.At < TimeSpan.FromMinutes(1)) return cached.Support;
            var support = LinuxSupport(GssapiInstalled, Environment.GetEnvironmentVariable("KRB5_KTNAME"), Readable);
            _linux = (DateTime.UtcNow, support);
            return support;
        }
        return MachineDomain() is { } domain
            ? new(true, "kestrel", $"Service Windows : serveur membre du domaine {domain}, Kerberos ou NTLM.")
            : new(true, "kestrel", "Service Windows : ce serveur ne semble pas joint à un domaine ; seuls ses comptes locaux pourront se connecter (NTLM).");
    }

    /// <summary>
    /// Linux (service systemd ou Docker) : Negotiate passe par la bibliothèque GSSAPI du système et le keytab du compte de service.
    /// Sans eux, l'activation serait acceptée mais chaque connexion échouerait : elle est refusée avec la marche à suivre.
    /// </summary>
    internal static HostSupport LinuxSupport(Func<bool> gssapi, string? keytabVariable, Func<string, bool> readable)
    {
        if (!gssapi())
            return new(false, "kestrel", $"Linux : bibliothèque GSSAPI absente ({GssapiLibrary}) : installez le paquet libgssapi-krb5-2 (Debian, Ubuntu) "
                + "ou krb5-libs (Red Hat). L'image Docker de Wolflog l'inclut depuis la version 0.4.4.");
        var keytab = KeytabPath(keytabVariable);
        if (keytab is not null && !readable(keytab))
            return new(false, "kestrel", $"Linux : keytab du compte de service introuvable ou illisible ({keytab}) : montez-le, lisible par le compte "
                + "qui exécute Wolflog (app, uid 1654, dans l'image Docker), et indiquez son chemin dans la variable KRB5_KTNAME.");
        return new(true, "kestrel", $"Linux : Kerberos avec le keytab {keytab ?? keytabVariable}. Ouvrez Wolflog par le nom DNS de son SPN "
            + "(HTTP/wolflog.contoso.local), jamais par son adresse IP. Groupes : avec l'annuaire LDAP et un compte de service.");
    }

    /// <summary>
    /// Fichier du keytab : KRB5_KTNAME (« FILE:/chemin », « WRFILE:/chemin » ou « /chemin »), sinon /etc/krb5.keytab ; null pour un
    /// autre type (MEMORY:, KEYRING:…), qui ne se vérifie pas ici.
    /// </summary>
    internal static string? KeytabPath(string? variable)
    {
        var value = string.IsNullOrWhiteSpace(variable) ? "/etc/krb5.keytab" : variable.Trim();
        var colon = value.IndexOf(':');
        if (colon <= 0) return value;
        return value[..colon].ToUpperInvariant() is "FILE" or "WRFILE" ? value[(colon + 1)..] : null;
    }

    private static bool GssapiInstalled()
    {
        if (!NativeLibrary.TryLoad(GssapiLibrary, out var handle)) return false;
        NativeLibrary.Free(handle);
        return true;
    }

    private static bool Readable(string path)
    {
        try
        {
            using var keytab = File.OpenRead(path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static string? MachineDomain()
    {
        try { return IPGlobalProperties.GetIPGlobalProperties().DomainName is { Length: > 0 } domain ? domain : null; }
        catch (NetworkInformationException) { return null; }
    }
}
