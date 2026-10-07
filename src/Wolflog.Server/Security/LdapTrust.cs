using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Wolflog.Server.Security;

/// <summary>
/// Autorité de certification propre à l'annuaire (autorité interne de l'entreprise, AD CS…), collée dans les réglages : le
/// certificat de l'annuaire est accepté s'il en descend, sans rien installer sur le serveur ni dans l'image Docker. Les
/// autorités du système restent approuvées, et le nom du serveur est toujours vérifié.
/// </summary>
public static class LdapTrust
{
    /// <summary>Certificats du texte PEM (racine, intermédiaires éventuels) ; null si aucun n'est lisible.</summary>
    public static X509Certificate2Collection? Load(string? pem)
    {
        if (string.IsNullOrWhiteSpace(pem)) return null;
        var certificates = new X509Certificate2Collection();
        try
        {
            certificates.ImportFromPem(pem);
        }
        catch (CryptographicException)
        {
            return null;
        }
        return certificates.Count > 0 ? certificates : null;
    }

    /// <summary>
    /// Certificat présenté par l'annuaire : accepté s'il est reconnu par le système, ou si sa chaîne (intermédiaires envoyés par
    /// le serveur compris) mène à l'une des autorités racines fournies. Jamais quand le nom du serveur ne correspond pas.
    /// </summary>
    public static bool Accepts(X509Certificate? certificate, X509Chain? presented, SslPolicyErrors errors, X509Certificate2Collection authorities)
    {
        if (errors == SslPolicyErrors.None) return true;
        if (certificate is null || (errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        // Autorité interne : sa liste de révocation est rarement joignable depuis un conteneur (comme la vérification habituelle).
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        foreach (var authority in authorities)
            (SelfSigned(authority) ? chain.ChainPolicy.CustomTrustStore : chain.ChainPolicy.ExtraStore).Add(authority);
        if (presented is not null)
        {
            chain.ChainPolicy.ExtraStore.AddRange(presented.ChainPolicy.ExtraStore);
            foreach (var element in presented.ChainElements) chain.ChainPolicy.ExtraStore.Add(element.Certificate);
        }
        if (certificate is X509Certificate2 server) return chain.Build(server);
        using var copy = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
        return chain.Build(copy);
    }

    /// <summary>Autorités fournies, pour l'administrateur : nom et fin de validité.</summary>
    public static IEnumerable<object> Describe(string? pem) =>
        Load(pem)?.Select(c => (object)new { subject = c.GetNameInfo(X509NameType.SimpleName, false), expires = c.NotAfter.ToUniversalTime() }) ?? [];

    private static bool SelfSigned(X509Certificate2 certificate) => certificate.SubjectName.RawData.AsSpan().SequenceEqual(certificate.IssuerName.RawData);
}
