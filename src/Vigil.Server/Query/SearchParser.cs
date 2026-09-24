using System.Text;
using Vigil.Server.Storage;

namespace Vigil.Server.Query;

/// <summary>
/// Requête parsée depuis la barre de recherche :
///   service:api level:warn host:web-1 http.route:/users/* "texte exact" timeout -bruit
/// Les mots libres sont cherchés dans le message et l'exception ; key:value inconnu = attribut.
/// </summary>
public sealed class SearchQuery
{
    public List<string> Services { get; } = [];
    public byte MinSeverity { get; set; }
    public List<string> Terms { get; } = [];
    public List<string> ExcludedTerms { get; } = [];
    public string? TraceId { get; set; }
    public string? Fingerprint { get; set; }
    public bool? Crash { get; set; }
    public bool ExceptionsOnly { get; set; }
    public List<(string Column, string Value)> Columns { get; } = [];
    public List<(string Key, string Value)> Attributes { get; } = [];

    private static readonly Dictionary<string, string> ColumnAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["host"] = "host",
        ["env"] = "env",
        ["environment"] = "env",
        ["version"] = "version",
        ["category"] = "category",
        ["logger"] = "category",
        ["type"] = "exception_type",
        ["exception"] = "exception_type",
        ["span"] = "span_id",
        ["instance"] = "instance_id",
    };

    public static SearchQuery Parse(string? text)
    {
        var q = new SearchQuery();
        if (string.IsNullOrWhiteSpace(text)) return q;

        foreach (var token in Tokenize(text))
        {
            if (token.Quoted)
            {
                q.Terms.Add(token.Value);
                continue;
            }
            var t = token.Value;
            if (t.Length > 1 && t[0] == '-' && !t.Contains(':'))
            {
                q.ExcludedTerms.Add(t[1..]);
                continue;
            }
            var colon = t.IndexOf(':');
            if (colon > 0 && colon < t.Length - 1)
            {
                var key = t[..colon];
                var value = t[(colon + 1)..].Trim('"');
                switch (key.ToLowerInvariant())
                {
                    case "service": q.Services.Add(value); continue;
                    case "level":
                    case "severity": q.MinSeverity = Math.Max(q.MinSeverity, LevelToSeverity(value)); continue;
                    case "trace":
                    case "traceid": q.TraceId = value.ToLowerInvariant(); continue;
                    case "fingerprint": q.Fingerprint = value; continue;
                    case "crash": q.Crash = value is "true" or "1" or "yes"; continue;
                    case "has":
                        if (value.Equals("exception", StringComparison.OrdinalIgnoreCase)) { q.ExceptionsOnly = true; continue; }
                        break;
                }
                if (ColumnAliases.TryGetValue(key, out var column)) q.Columns.Add((column, value));
                else q.Attributes.Add((key, value));
                continue;
            }
            q.Terms.Add(t);
        }
        return q;
    }

    public static byte LevelToSeverity(string level) => level.ToLowerInvariant() switch
    {
        "trace" or "verbose" => 1,
        "debug" => 5,
        "info" or "information" => 9,
        "warn" or "warning" => 13,
        "error" => 17,
        "fatal" or "critical" => 21,
        _ => byte.TryParse(level, out var b) ? b : (byte)0,
    };

    public static string SeverityToLevel(byte severity) => severity switch
    {
        0 => "info",
        <= 4 => "trace",
        <= 8 => "debug",
        <= 12 => "info",
        <= 16 => "warn",
        <= 20 => "error",
        _ => "fatal",
    };

    private readonly record struct Token(string Value, bool Quoted);

    private static IEnumerable<Token> Tokenize(string text)
    {
        var sb = new StringBuilder();
        var inQuotes = false;
        var quotedToken = false;
        foreach (var c in text)
        {
            if (c == '"')
            {
                if (inQuotes)
                {
                    inQuotes = false;
                    // "a b" seul = phrase ; key:"a b" = valeur de champ
                    if (sb.Length > 0 && !sb.ToString().Contains(':')) quotedToken = true;
                }
                else
                {
                    inQuotes = true;
                }
                continue;
            }
            if (char.IsWhiteSpace(c) && !inQuotes)
            {
                if (sb.Length > 0) yield return new Token(sb.ToString(), quotedToken);
                sb.Clear();
                quotedToken = false;
                continue;
            }
            sb.Append(c);
        }
        if (sb.Length > 0) yield return new Token(sb.ToString(), quotedToken);
    }

    /// <summary>Le segment peut-il contenir des lignes correspondant à la requête ? (élagage sans lecture)</summary>
    public bool MayMatch(SegmentIndex index)
    {
        if (Services.Count > 0 && !Services.Any(index.Services.Contains)) return false;
        if (MinSeverity > 0 && index.MaxSeverity < MinSeverity) return false;
        if ((ExceptionsOnly || Fingerprint != null || Crash == true) && !index.HasExceptions) return false;
        if (TraceId != null && !index.TraceIds.MayContain(TraceId)) return false;
        if (index.Text != null)
        {
            foreach (var term in Terms)
                if (!index.Text.MayContain(term)) return false;
        }
        return true;
    }

    /// <summary>Évaluation en mémoire (live tail).</summary>
    public bool Matches(LogRow r)
    {
        if (Services.Count > 0 && !Services.Contains(r.Service)) return false;
        if (MinSeverity > 0 && r.Severity < MinSeverity) return false;
        if (TraceId != null && r.TraceId != TraceId) return false;
        if (Fingerprint != null && r.Fingerprint != Fingerprint) return false;
        if (Crash is { } crash && r.IsCrash != crash) return false;
        if (ExceptionsOnly && r.Fingerprint is null) return false;
        foreach (var term in Terms)
        {
            if (!r.Body.Contains(term, StringComparison.OrdinalIgnoreCase)
                && r.ExceptionMessage?.Contains(term, StringComparison.OrdinalIgnoreCase) != true
                && r.ExceptionType?.Contains(term, StringComparison.OrdinalIgnoreCase) != true)
                return false;
        }
        foreach (var term in ExcludedTerms)
            if (r.Body.Contains(term, StringComparison.OrdinalIgnoreCase)) return false;
        foreach (var (column, value) in Columns)
        {
            var actual = column switch
            {
                "host" => r.Host,
                "env" => r.Env,
                "version" => r.Version,
                "category" => r.Category,
                "exception_type" => r.ExceptionType,
                "span_id" => r.SpanId,
                "instance_id" => r.InstanceId,
                _ => null,
            };
            if (!WildcardEquals(actual, value)) return false;
        }
        if (Attributes.Count > 0)
        {
            using var doc = System.Text.Json.JsonDocument.Parse(r.Attributes);
            foreach (var (key, value) in Attributes)
            {
                if (!doc.RootElement.TryGetProperty(key, out var prop)) return false;
                var actual = prop.ValueKind == System.Text.Json.JsonValueKind.String ? prop.GetString() : prop.GetRawText();
                if (!WildcardEquals(actual, value)) return false;
            }
        }
        return true;
    }

    private static bool WildcardEquals(string? actual, string pattern)
    {
        if (actual is null) return false;
        if (!pattern.Contains('*')) return string.Equals(actual, pattern, StringComparison.Ordinal);
        var regex = "^" + System.Text.RegularExpressions.Regex.Escape(pattern).Replace("\\*", ".*") + "$";
        return System.Text.RegularExpressions.Regex.IsMatch(actual, regex, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    /// <summary>Conditions SQL (pour la table logs).</summary>
    public void AppendLogFilters(List<string> where)
    {
        if (Services.Count > 0) where.Add($"service IN {Sql.List(Services)}");
        if (MinSeverity > 0) where.Add($"severity >= {MinSeverity}");
        if (TraceId != null) where.Add($"trace_id = {Sql.Str(TraceId)}");
        if (Fingerprint != null) where.Add($"fingerprint = {Sql.Str(Fingerprint)}");
        if (Crash is { } crash) where.Add(crash ? "is_crash" : "NOT is_crash");
        if (ExceptionsOnly) where.Add("fingerprint IS NOT NULL");
        foreach (var term in Terms)
        {
            var like = Sql.Like(term);
            where.Add($"(body ILIKE {like} ESCAPE '\\' OR exception_message ILIKE {like} ESCAPE '\\' OR exception_type ILIKE {like} ESCAPE '\\')");
        }
        foreach (var term in ExcludedTerms)
            where.Add($"body NOT ILIKE {Sql.Like(term)} ESCAPE '\\'");
        foreach (var (column, value) in Columns)
            where.Add(ValueFilter(column, value));
        foreach (var (key, value) in Attributes)
            where.Add(ValueFilter($"json_extract_string(attributes, {Sql.Str("$.\"" + key.Replace("\"", "") + "\"")})", value));
    }

    /// <summary>Égalité, ou motif avec * (ex: /users/*).</summary>
    public static string ValueFilter(string expression, string value)
    {
        if (value.Contains('*'))
        {
            var pattern = value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace('*', '%');
            return $"{expression} ILIKE {Sql.Str(pattern)} ESCAPE '\\'";
        }
        return $"{expression} = {Sql.Str(value)}";
    }
}
