using System.Text.RegularExpressions;

namespace Wolflog.Client.Internal;

/// <summary>Masquage des données sensibles et mise en forme des corps capturés.</summary>
internal sealed class HttpCaptureRules
{
    public const string RequestBody = "http.request.body";
    public const string RequestQuery = "http.request.query";
    public const string ResponseBody = "http.response.body";

    private readonly HashSet<string> _redactedHeaders;
    private readonly Regex? _jsonFields;
    private readonly Regex? _formFields;

    public HttpCaptureOptions Options { get; }

    public HttpCaptureRules(HttpCaptureOptions options)
    {
        Options = options;
        _redactedHeaders = new HashSet<string>(options.RedactedHeaders, StringComparer.OrdinalIgnoreCase);
        if (options.RedactedFields.Count > 0)
        {
            var names = string.Join("|", options.RedactedFields.Select(Regex.Escape));
            _jsonFields = new Regex($"(\"(?:{names})\"\\s*:\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"|[^,}}\\]\\s]+)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
            _formFields = new Regex($"((?:^|&)(?:{names})=)[^&]*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
        }
    }

    /// <summary>Chaîne de requête complète (OpenTelemetry la masque par défaut), champs sensibles remplacés par ***.</summary>
    public string Query(string query)
    {
        var q = query.TrimStart('?');
        return _formFields is null ? q : _formFields.Replace(q, "$1***");
    }

    public bool ShouldKeepBodies(bool failed) => Options.Bodies == HttpBodyCapture.All || (Options.Bodies == HttpBodyCapture.Errors && failed);

    public string HeaderValue(string name, string value) => _redactedHeaders.Contains(name) ? "***" : value;

    public static bool IsTextual(string? contentType)
    {
        if (string.IsNullOrEmpty(contentType)) return false;
        var ct = contentType.ToLowerInvariant();
        if (ct.Contains("event-stream")) return false;
        return ct.StartsWith("text/") || ct.Contains("json") || ct.Contains("xml") || ct.Contains("x-www-form-urlencoded") || ct.Contains("graphql");
    }

    /// <summary>Décode les octets capturés, masque les champs sensibles et signale une éventuelle troncature.</summary>
    public string Format(ReadOnlySpan<byte> bytes, long totalLength, string? contentType)
    {
        var text = Encoding.UTF8.GetString(bytes);
        if (bytes.Length > 0 && text[^1] == '�') text = text[..^1]; // caractère coupé par la limite
        if (_jsonFields != null && contentType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true)
            text = _jsonFields.Replace(text, "$1\"***\"");
        else if (_formFields != null && contentType?.Contains("form-urlencoded", StringComparison.OrdinalIgnoreCase) == true)
            text = _formFields.Replace(text, "$1***");
        // Format fixe (sans séparateur dépendant de la langue) : l'interface le reconnaît pour afficher la taille réelle.
        if (totalLength > bytes.Length) text += $"\n… [tronqué : {totalLength.ToString(System.Globalization.CultureInfo.InvariantCulture)} octets au total]";
        return text;
    }

    public static string Placeholder(string? contentType, long? length) =>
        $"[contenu non textuel : {contentType ?? "type inconnu"}{(length is > 0 ? $", {length:N0} octets" : "")}]";
}
