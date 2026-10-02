using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Wolflog.Server.Configuration;

/// <summary>
/// Contrôle du logo de l'entreprise : PNG, JPEG, WebP ou SVG de 1 Mo au plus, type reconnu au contenu du fichier
/// (signature), jamais à son nom. Un SVG est refusé s'il peut exécuter du code ou charger une ressource extérieure ;
/// il est de plus toujours servi avec une politique de sécurité (CSP) qui l'en empêcherait.
/// </summary>
public static partial class BrandingLogo
{
    public const int MaxBytes = 1024 * 1024;
    public const string Svg = "image/svg+xml";

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    private static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF];

    /// <summary>Type MIME du logo, ou la raison de son refus.</summary>
    public static (string? ContentType, string? Error) Check(byte[] content)
    {
        if (content.Length == 0) return (null, "Fichier vide.");
        if (content.Length > MaxBytes) return (null, "Logo trop lourd : 1 Mo au plus.");
        ReadOnlySpan<byte> bytes = content;
        if (bytes.StartsWith(Png)) return ("image/png", null);
        if (bytes.StartsWith(Jpeg)) return ("image/jpeg", null);
        if (bytes.Length >= 12 && bytes[..4].SequenceEqual("RIFF"u8) && bytes[8..12].SequenceEqual("WEBP"u8)) return ("image/webp", null);
        var text = Encoding.UTF8.GetString(content);
        if (!IsSvg(text)) return (null, "Format non reconnu : PNG, JPEG, WebP ou SVG attendu.");
        return UnsafeSvg(text) is { } reason ? (null, $"SVG refusé : {reason}.") : (Svg, null);
    }

    /// <summary>Empreinte courte du contenu : version de l'adresse du logo (un nouveau logo change d'adresse).</summary>
    public static string Version(byte[] content) => Convert.ToHexStringLower(SHA256.HashData(content))[..12];

    /// <summary>Document SVG : après l'en-tête XML, les commentaires et le DOCTYPE éventuels, l'élément racine est svg.</summary>
    private static bool IsSvg(string text)
    {
        var rest = text.AsSpan().TrimStart('﻿');
        while (true)
        {
            rest = rest.TrimStart();
            if (rest.StartsWith("<?") || rest.StartsWith("<!--"))
            {
                var close = rest.StartsWith("<?") ? "?>" : "-->";
                var end = rest.IndexOf(close);
                if (end < 0) return false;
                rest = rest[(end + close.Length)..];
            }
            else if (rest.StartsWith("<!DOCTYPE svg"))
            {
                var end = rest.IndexOf('>');
                // Sous-ensemble interne ([…]) : il pourrait déclarer des entités.
                if (end < 0 || rest[..end].Contains('[')) return false;
                rest = rest[(end + 1)..];
            }
            else
            {
                return rest.StartsWith("<svg") && rest.Length > 4 && (char.IsWhiteSpace(rest[4]) || rest[4] is '>' or '/');
            }
        }
    }

    private static string? UnsafeSvg(string text) =>
        ActiveElement().IsMatch(text) ? "il contient un script, du HTML ou un document embarqué"
        : EventAttribute().IsMatch(text) ? "il contient un attribut d'événement (onload, onclick…)"
        : ExternalLink().IsMatch(text) || ExternalStyle().IsMatch(text) ? "il fait référence à une ressource extérieure"
        : HiddenRisk().IsMatch(text) ? "il contient des entités, une feuille XSLT, un lien javascript ou du HTML"
        : null;

    // Éléments qui exécutent du code, embarquent du HTML ou un autre document (préfixe d'espace de noms compris).
    [GeneratedRegex(@"<\s*(?:[\w.-]+:)?(?:script|foreignObject|iframe|frame|embed|object|applet|meta|base|link|handler)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ActiveElement();

    // Attributs d'événement : onload=, onclick=, onbegin=…
    [GeneratedRegex(@"[\s/""']on[a-z]+\s*=", RegexOptions.IgnoreCase)]
    private static partial Regex EventAttribute();

    // Liens (href, xlink:href, src) vers autre chose qu'un élément du document (#id) ou une image embarquée (data:image/png…).
    [GeneratedRegex(@"[\s""'](?:[\w-]+:)?(?:href|src)\s*=\s*[""'](?>\s*)(?!#|data:image/(?:png|jpe?g|gif|webp)[;,])", RegexOptions.IgnoreCase)]
    private static partial Regex ExternalLink();

    // Styles : url(…) autre qu'une référence interne (url(#dégradé)), @import.
    [GeneratedRegex(@"url\((?>\s*[""']?\s*)(?!#)|@import", RegexOptions.IgnoreCase)]
    private static partial Regex ExternalStyle();

    // Entités (elles peuvent cacher n'importe quel balisage), feuilles XSLT, liens javascript:, animation d'un lien, HTML.
    [GeneratedRegex(@"<!ENTITY|<\?xml-stylesheet|javascript:|attributeName\s*=\s*[""']\s*(?:[\w-]+:)?href|http://www\.w3\.org/1999/xhtml", RegexOptions.IgnoreCase)]
    private static partial Regex HiddenRisk();
}
