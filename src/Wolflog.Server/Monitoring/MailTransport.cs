using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using MailKit;
using MailKit.Security;

namespace Wolflog.Server.Monitoring;

/// <summary>Réglages communs SMTP / IMAP (MailKit) : mode de sécurité, certificat, messages d'erreur lisibles.</summary>
public static class MailTransport
{
    /// <summary>
    /// Mode de connexion. auto : TLS dès la connexion sur 465 / 993, sinon STARTTLS s'il est proposé. starttls : exigé
    /// (pas d'envoi en clair si le serveur ne le propose plus). ssl : TLS dès la connexion. none : sans chiffrement.
    /// </summary>
    public static SecureSocketOptions Options(string? security, int port) => (security ?? "auto").ToLowerInvariant() switch
    {
        "ssl" or "tls" => SecureSocketOptions.SslOnConnect,
        "starttls" => SecureSocketOptions.StartTls,
        "none" => SecureSocketOptions.None,
        _ => port is 465 or 993 or 995 ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTlsWhenAvailable,
    };

    /// <summary>Validation du certificat, avec relevé de sa date d'expiration (jours restants).</summary>
    public static RemoteCertificateValidationCallback Validate(bool ignoreErrors, Action<int> expiresInDays) => (_, cert, _, errors) =>
    {
        if (cert is not null)
            expiresInDays((int)Math.Floor(((cert as X509Certificate2 ?? new X509Certificate2(cert)).NotAfter.ToUniversalTime() - DateTime.UtcNow).TotalDays));
        return ignoreErrors || errors == SslPolicyErrors.None;
    };

    /// <summary>Message d'erreur compréhensible pour l'interface et les notifications.</summary>
    public static string Describe(Exception ex) => ex switch
    {
        AuthenticationException => "identifiant ou mot de passe refusé par le serveur",
        SslHandshakeException => "échec de la négociation TLS (certificat invalide, ou port et sécurité qui ne correspondent pas : 465 = SSL, 587 = STARTTLS)",
        SocketException s when s.SocketErrorCode == SocketError.HostNotFound => "serveur introuvable (nom DNS inconnu)",
        SocketException s when s.SocketErrorCode == SocketError.ConnectionRefused => "connexion refusée (port fermé ou mauvais port)",
        SocketException s when s.SocketErrorCode == SocketError.TimedOut => "serveur injoignable (délai dépassé, pare-feu ?)",
        SocketException s => $"connexion impossible ({s.SocketErrorCode})",
        TimeoutException or OperationCanceledException => "pas de réponse du serveur dans le délai",
        CommandException c => "refusé par le serveur : " + c.Message,
        NotSupportedException n => n.Message,
        _ => ex.InnerException is { } inner && ex is IOException ? Describe(inner) : ex.Message,
    };

    /// <summary>Exceptions attendues d'un échange SMTP / IMAP (à traiter comme un échec, pas comme un bogue).</summary>
    public static bool IsMailError(Exception ex) => ex is IOException or SocketException or CommandException or ProtocolException
        or AuthenticationException or SslHandshakeException or ServiceNotConnectedException or ServiceNotAuthenticatedException
        or TimeoutException or NotSupportedException or FormatException or InvalidOperationException or MimeKit.ParseException;
}
