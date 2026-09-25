using System.Globalization;

namespace Wolflog.Server.Configuration;

/// <summary>
/// Format des nombres à la française (virgule décimale, espace fine pour les milliers),
/// indépendant des cultures installées : le serveur tourne en globalisation invariante.
/// </summary>
public static class French
{
    public static readonly NumberFormatInfo Numbers = CreateNumbers();

    private static NumberFormatInfo CreateNumbers()
    {
        var n = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
        n.NumberDecimalSeparator = ",";
        n.NumberGroupSeparator = " ";
        n.PercentDecimalSeparator = ",";
        n.PercentGroupSeparator = " ";
        return NumberFormatInfo.ReadOnly(n);
    }
}
