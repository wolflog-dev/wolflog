using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Vigil.Server.Ingestion;

/// <summary>
/// Empreinte d'une exception : même type + mêmes frames d'appel = même "problème",
/// indépendamment des numéros de ligne, des ids ou des valeurs contenues dans le message.
/// </summary>
public static partial class Fingerprint
{
    private const int MaxFrames = 10;

    public static string Compute(string exceptionType, string? message, string? stackTrace)
    {
        var sb = new StringBuilder(256);
        sb.Append(exceptionType.Trim()).Append('|');

        var frames = 0;
        if (!string.IsNullOrEmpty(stackTrace))
        {
            foreach (var raw in stackTrace.AsSpan().EnumerateLines())
            {
                var line = raw.Trim();
                string? frame = null;
                if (line.StartsWith("at ")) frame = line[3..].ToString();
                else if (line.StartsWith("à ")) frame = line[2..].ToString();
                if (frame is null) continue;

                // Retire " in C:\src\file.cs:line 42" / " dans ...:ligne 42"
                var cut = frame.IndexOf(" in ", StringComparison.Ordinal);
                if (cut < 0) cut = frame.IndexOf(" dans ", StringComparison.Ordinal);
                if (cut > 0) frame = frame[..cut];

                sb.Append(Normalize(frame)).Append('|');
                if (++frames >= MaxFrames) break;
            }
        }

        if (frames == 0 && !string.IsNullOrEmpty(message))
            sb.Append(NormalizeMessage(message));

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()));
        return Convert.ToHexStringLower(hash, 0, 8);
    }

    // Les méthodes générées par le compilateur (<Main>b__0_1, d__12) changent de numéro à chaque build.
    private static string Normalize(string frame) => Digits().Replace(frame, "#");

    public static string NormalizeMessage(string message)
    {
        var m = Guid().Replace(message, "<guid>");
        m = Quoted().Replace(m, "'<v>'");
        m = Hex().Replace(m, "<hex>");
        m = Digits().Replace(m, "#");
        return m.Length > 200 ? m[..200] : m;
    }

    [GeneratedRegex(@"\d+")] private static partial Regex Digits();
    [GeneratedRegex(@"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")] private static partial Regex Guid();
    [GeneratedRegex(@"'[^']*'|""[^""]*""")] private static partial Regex Quoted();
    [GeneratedRegex(@"0x[0-9a-fA-F]+")] private static partial Regex Hex();
}
