using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;

namespace Wolflog.Server.Analytics;

/// <summary>
/// Jetons de la carte de chaleur affichée sur le site lui-même (« Ouvrir sur le site ») : la page du site, ouverte avec la
/// session de la personne, lit les clics auprès de Wolflog sans cookie Wolflog. Lecture seule, valable quelques heures,
/// chiffré et signé par la protection des données de Wolflog (clés du dossier de données).
/// </summary>
public sealed class HeatmapViewerTokens(IDataProtectionProvider provider)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(4);
    private readonly ITimeLimitedDataProtector _protector = provider.CreateProtector("Wolflog.HeatmapViewer").ToTimeLimitedDataProtector();

    public string Issue(HeatmapViewerGrant grant) => _protector.Protect(JsonSerializer.Serialize(grant), Lifetime);

    /// <summary>Droits du jeton ; null s'il est absent, falsifié ou expiré.</summary>
    public HeatmapViewerGrant? Read(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        try { return JsonSerializer.Deserialize<HeatmapViewerGrant>(_protector.Unprotect(token)); }
        catch (Exception ex) when (ex is CryptographicException or JsonException or FormatException) { return null; }
    }
}
