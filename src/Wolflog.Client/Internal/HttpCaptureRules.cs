using System.Net;
using System.Text.RegularExpressions;

namespace Wolflog.Client.Internal;

/// <summary>Masquage des données sensibles et mise en forme des corps capturés.</summary>
internal sealed class HttpCaptureRules
{
    public const string RequestBody = "http.request.body";
    public const string RequestQuery = "http.request.query";
    public const string ResponseBody = "http.response.body";

    // Clé JSON suivie d'une valeur simple (texte, nombre, booléen, null). Une valeur objet ou tableau n'est pas prise :
    // la recherche continue à l'intérieur, où chaque champ sensible est masqué.
    private static readonly Regex JsonField = new("\"((?:[^\"\\\\]|\\\\.)*)\"(\\s*:\\s*)(?:\"(?:[^\"\\\\]|\\\\.)*\"|[^,{}\\[\\]\\s]+)",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    // Champ de formulaire ou paramètre d'adresse : nom=valeur.
    private static readonly Regex FormField = new("(^|&)([^=&]*)=[^&]*", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private readonly HashSet<string> _redactedHeaders;
    private readonly HashSet<string> _redactedFields;
    private readonly string[][] _redactedWords;

    public HttpCaptureOptions Options { get; }

    public HttpCaptureRules(HttpCaptureOptions options)
    {
        Options = options;
        _redactedHeaders = new HashSet<string>(options.RedactedHeaders, StringComparer.OrdinalIgnoreCase);
        _redactedFields = new HashSet<string>(options.RedactedFields, StringComparer.OrdinalIgnoreCase);
        // Les entrées sont découpées comme les noms : « api key », « api_key » et « apiKey » donnent api, key.
        _redactedWords = options.RedactedWords.Select(w => Words(w).ToArray()).Where(w => w.Length > 0).ToArray();
    }

    private bool Masks => _redactedFields.Count > 0 || _redactedWords.Length > 0;

    /// <summary>Chaîne de requête complète (OpenTelemetry la masque par défaut), champs sensibles remplacés par ***.</summary>
    public string Query(string query)
    {
        var q = query.TrimStart('?');
        return Masks ? MaskForm(q) : q;
    }

    public bool ShouldKeepBodies(bool failed) => Options.Bodies == HttpBodyCapture.All || (Options.Bodies == HttpBodyCapture.Errors && failed);

    public string HeaderValue(string name, string value) =>
        _redactedHeaders.Contains(name) || ContainsRedactedWord(name) ? "***" : value;

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
        if (Masks && contentType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true)
            text = JsonField.Replace(text, m => IsRedacted(m.Groups[1].Value) ? $"\"{m.Groups[1].Value}\"{m.Groups[2].Value}\"***\"" : m.Value);
        else if (Masks && contentType?.Contains("form-urlencoded", StringComparison.OrdinalIgnoreCase) == true)
            text = MaskForm(text);
        // Format fixe (sans séparateur dépendant de la langue) : l'interface le reconnaît pour afficher la taille réelle.
        if (totalLength > bytes.Length) text += $"\n… [tronqué : {totalLength.ToString(System.Globalization.CultureInfo.InvariantCulture)} octets au total]";
        return text;
    }

    public static string Placeholder(string? contentType, long? length) =>
        $"[contenu non textuel : {contentType ?? "type inconnu"}{(length is > 0 ? $", {length:N0} octets" : "")}]";

    private string MaskForm(string text) =>
        FormField.Replace(text, m => IsRedacted(WebUtility.UrlDecode(m.Groups[2].Value)) ? $"{m.Groups[1].Value}{m.Groups[2].Value}=***" : m.Value);

    /// <summary>Champ à masquer : nom exact de RedactedFields, ou nom qui contient un mot de RedactedWords.</summary>
    internal bool IsRedacted(string name) => _redactedFields.Contains(name) || ContainsRedactedWord(name);

    private bool ContainsRedactedWord(string name)
    {
        if (_redactedWords.Length == 0) return false;
        var words = Words(name);
        foreach (var redacted in _redactedWords)
        {
            for (var i = 0; i + redacted.Length <= words.Count; i++)
            {
                var j = 0;
                while (j < redacted.Length && words[i + j] == redacted[j]) j++;
                if (j == redacted.Length) return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Mots d'un nom, en minuscules : accountNewPassword → account, new, password ; RADIUS_PASSWORD → radius, password ;
    /// SIP_MD5SECRET → sip, md, 5, secret ; XMLHttpRequest → xml, http, request.
    /// </summary>
    internal static List<string> Words(string name)
    {
        var words = new List<string>();
        var start = -1;
        for (var i = 0; i < name.Length; i++)
        {
            if (!char.IsLetterOrDigit(name[i]))
            {
                if (start >= 0) words.Add(name[start..i].ToLowerInvariant());
                start = -1;
                continue;
            }
            if (start >= 0 && StartsWord(name, i))
            {
                words.Add(name[start..i].ToLowerInvariant());
                start = i;
            }
            if (start < 0) start = i;
        }
        if (start >= 0) words.Add(name[start..].ToLowerInvariant());
        return words;
    }

    // Nouveau mot à la position i : minuscule puis majuscule (camelCase), passage lettre ↔ chiffre, ou fin d'un sigle
    // (la majuscule suivie d'une minuscule dans XMLHttp commence « Http »).
    private static bool StartsWord(string name, int i)
    {
        char previous = name[i - 1], current = name[i];
        if (char.IsLower(previous) && char.IsUpper(current)) return true;
        if (char.IsDigit(previous) != char.IsDigit(current)) return true;
        return char.IsUpper(previous) && char.IsUpper(current) && i + 1 < name.Length && char.IsLower(name[i + 1]);
    }
}
