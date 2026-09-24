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

        // Seules les frames de l'application comptent : celles du framework varient selon le JIT (inlining),
        // le middleware en place, la version du runtime…
        var all = ParseFrames(stackTrace);
        var app = all.Where(f => !IsFramework(f)).Take(MaxFrames).ToList();
        var frames = app.Count > 0 ? app : all.Take(3).ToList();
        foreach (var f in frames) sb.Append(Normalize(f)).Append('|');

        if (frames.Count == 0 && !string.IsNullOrEmpty(message))
            sb.Append(NormalizeMessage(message));

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()));
        return Convert.ToHexStringLower(hash, 0, 8);
    }

    private static List<string> ParseFrames(string? stackTrace)
    {
        var frames = new List<string>();
        if (string.IsNullOrEmpty(stackTrace)) return frames;
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
            frames.Add(frame);
        }
        return frames;
    }

    private static readonly string[] FrameworkPrefixes =
        ["System.", "Microsoft.", "lambda_method", "Grpc.", "Serilog.", "OpenTelemetry.", "Npgsql.", "Newtonsoft.", "Polly.", "---"];

    private static bool IsFramework(string frame)
    {
        foreach (var p in FrameworkPrefixes)
            if (frame.StartsWith(p, StringComparison.Ordinal)) return true;
        return false;
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
