using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vigil.Server.Sources;

/// <summary>Requête HTTP lue dans un journal (IIS, accès web) : devient un span serveur.</summary>
public sealed record HttpEntry(string Method, string Path, string? Query, int Status, double DurationMs, string? ClientIp, string? UserAgent, string? Host);

/// <summary>Entrée normalisée, quelle que soit la source.</summary>
public sealed class ParsedEntry
{
    public DateTime Ts { get; set; } = DateTime.UtcNow;
    /// <summary>Sévérité OpenTelemetry (1-24) : 5 debug, 9 info, 13 warn, 17 error, 21 fatal.</summary>
    public int Severity { get; set; } = 9;
    public string Body { get; set; } = "";
    public string? Service { get; set; }
    public string? Host { get; set; }
    public string? Category { get; set; }
    public Dictionary<string, string> Attributes { get; } = [];
    public HttpEntry? Http { get; set; }
}

/// <summary>Formats de lignes reconnus par les sources fichier.</summary>
public static partial class LineParsers
{
    private static readonly System.Text.UTF8Encoding Strict = new(false, throwOnInvalidBytes: true);

    /// <summary>Texte UTF-8, ou Windows-1252/Latin-1 si les octets ne sont pas de l'UTF-8 valide (sorties console Windows).</summary>
    public static string Decode(byte[] bytes, int count)
    {
        try { return Strict.GetString(bytes, 0, count); }
        catch (System.Text.DecoderFallbackException) { return System.Text.Encoding.Latin1.GetString(bytes, 0, count); }
    }

    public static readonly string[] Formats = ["auto", "plain", "json", "iis", "docker", "cri"];

    /// <summary>Analyse une ligne selon le format de la source (« auto » : détection ligne par ligne).</summary>
    public static ParsedEntry? ParseLine(string format, string line, W3C w3c) => format switch
    {
        "iis" => w3c.Parse(line),
        "json" => Json(line) ?? Plain(line),
        "docker" => Docker(line) ?? Plain(line),
        "cri" => Cri(line) ?? Plain(line),
        "plain" => Plain(line),
        _ => line.StartsWith('#') || w3c.HasFields ? w3c.Parse(line)
            : line.StartsWith("{\"log\":", StringComparison.Ordinal) ? Docker(line) ?? Plain(line)
            : line.StartsWith('{') ? Json(line) ?? Plain(line)
            : Cri(line) ?? Plain(line),
    };

    // Pile d'appels : lignes « at … », « --- », « Caused by », et l'en-tête « System.XxxException: message ».
    [GeneratedRegex(@"^(\s+at |\s+---|\s+\.\.\.|Caused by:|\s+File ""|[\w.]+(?:Exception|Error)(?::|$))")]
    private static partial Regex ContinuationLine();

    /// <summary>Ligne qui prolonge l'entrée précédente (pile d'appels .NET, Java, Python).</summary>
    public static bool IsContinuation(string line) => ContinuationLine().IsMatch(line);

    /// <summary>Sévérité déduite d'un mot (ERROR, warn, Information, crit…).</summary>
    public static int SeverityFromText(string? level) => level?.Trim().ToLowerInvariant() switch
    {
        null or "" => 9,
        "trace" or "verbose" or "vrb" or "trc" => 1,
        "debug" or "dbug" or "dbg" => 5,
        "info" or "information" or "inf" or "notice" or "informational" => 9,
        "warn" or "warning" or "wrn" => 13,
        "error" or "err" or "fail" or "eror" => 17,
        "fatal" or "critical" or "crit" or "ftl" or "alert" or "emerg" or "emergency" or "panic" => 21,
        _ => 9,
    };

    // Mots complets et abréviations courantes (Serilog : INF, WRN, ERR ; .NET : info, warn, fail, crit).
    [GeneratedRegex(@"\b(TRACE|VRB|DEBUG|DBG|DBUG|INFO|INF|INFORMATION|NOTICE|WARN|WRN|WARNING|ERROR|ERR|FAIL|FATAL|FTL|CRITICAL|CRIT)\b", RegexOptions.IgnoreCase)]
    private static partial Regex LevelWord();

    [GeneratedRegex(@"^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?")]
    private static partial Regex LeadingTimestamp();

    // Heure seule en tête (console Serilog « [10:18:07 INF] ») : aujourd'hui, heure locale.
    [GeneratedRegex(@"^\[?(\d{2}:\d{2}:\d{2})(?:[.,]\d+)?\b")]
    private static partial Regex LeadingTime();

    /// <summary>Ligne de texte libre : horodatage en tête et niveau reconnus s'ils sont présents.</summary>
    public static ParsedEntry Plain(string line)
    {
        var e = new ParsedEntry { Body = line };
        var ts = LeadingTimestamp().Match(line);
        if (ts.Success && DateTime.TryParse(ts.Groups[1].Value.Replace(',', '.'), CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeLocal, out var t))
            e.Ts = DateTime.SpecifyKind(t, DateTimeKind.Utc);
        else if (LeadingTime().Match(line) is { Success: true } time && TimeSpan.TryParse(time.Groups[1].Value, CultureInfo.InvariantCulture, out var tod))
        {
            var local = DateTime.Today + tod;
            if (local > DateTime.Now.AddMinutes(5)) local = local.AddDays(-1); // ligne d'hier lue après minuit
            e.Ts = local.ToUniversalTime();
        }
        var level = LevelWord().Match(line.Length > 120 ? line[..120] : line);
        if (level.Success) e.Severity = SeverityFromText(level.Value);
        return e;
    }

    /// <summary>JSON par ligne (Serilog compact, pino, bunyan, logs structurés…).</summary>
    public static ParsedEntry? Json(string line)
    {
        if (!line.StartsWith('{')) return null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            var e = new ParsedEntry();
            foreach (var p in root.EnumerateObject())
            {
                var name = p.Name;
                var value = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() ?? "" : p.Value.GetRawText();
                switch (name.ToLowerInvariant())
                {
                    case "@t" or "timestamp" or "time" or "ts" or "@timestamp" or "date":
                        if (p.Value.ValueKind == JsonValueKind.Number && p.Value.TryGetInt64(out var epoch))
                            e.Ts = epoch > 100_000_000_000 ? DateTime.UnixEpoch.AddMilliseconds(epoch) : DateTime.UnixEpoch.AddSeconds(epoch);
                        else if (DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t))
                            e.Ts = DateTime.SpecifyKind(t, DateTimeKind.Utc);
                        break;
                    case "@l" or "level" or "severity" or "lvl" or "loglevel":
                        e.Severity = p.Value.ValueKind == JsonValueKind.Number
                            ? PinoLevel(p.Value.GetInt32())
                            : SeverityFromText(value);
                        break;
                    case "@m" or "@mt" or "message" or "msg":
                        if (string.IsNullOrEmpty(e.Body) || name is "@m" or "message" or "msg") e.Body = value;
                        break;
                    case "@x" or "exception" or "error" or "stack":
                        e.Attributes["exception.stacktrace"] = value;
                        break;
                    case "sourcecontext" or "logger" or "category":
                        e.Category = value;
                        break;
                    case "service" or "app" or "application":
                        e.Service = value;
                        break;
                    case "host" or "hostname":
                        e.Host = value;
                        break;
                    default:
                        e.Attributes[name] = value;
                        break;
                }
            }
            if (e.Body.Length == 0) e.Body = line;
            return e;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // pino / bunyan : 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.
    private static int PinoLevel(int n) => n switch { <= 10 => 1, <= 20 => 5, <= 30 => 9, <= 40 => 13, <= 50 => 17, _ => 21 };

    /// <summary>Docker (pilote json-file) : {"log":"…","stream":"stdout","time":"…"}.</summary>
    public static ParsedEntry? Docker(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (!root.TryGetProperty("log", out var log)) return null;
            var text = (log.GetString() ?? "").TrimEnd('\n', '\r');
            var inner = Json(text) ?? Plain(text);
            if (root.TryGetProperty("time", out var time) && DateTime.TryParse(time.GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal, out var t) && inner.Ts == default)
                inner.Ts = DateTime.SpecifyKind(t, DateTimeKind.Utc);
            if (root.TryGetProperty("stream", out var stream) && stream.GetString() == "stderr" && inner.Severity < 13) inner.Severity = 13;
            return inner;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    [GeneratedRegex(@"^(\S+) (stdout|stderr) ([FP]) (.*)$")]
    private static partial Regex CriLine();

    /// <summary>Kubernetes (containerd / CRI-O) : « 2026-09-25T10:00:00.123Z stdout F message ».</summary>
    public static ParsedEntry? Cri(string line)
    {
        var m = CriLine().Match(line);
        if (!m.Success) return null;
        var text = m.Groups[4].Value;
        var e = Json(text) ?? Plain(text);
        if (DateTime.TryParse(m.Groups[1].Value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var t))
            e.Ts = DateTime.SpecifyKind(t, DateTimeKind.Utc);
        if (m.Groups[2].Value == "stderr" && e.Severity < 13) e.Severity = 13;
        return e;
    }

    /// <summary>
    /// Journal IIS au format W3C : les lignes « #Fields: » donnent l'ordre des colonnes.
    /// Chaque requête devient un span serveur (visible dans Requêtes HTTP) ; les 5xx créent aussi un log d'erreur.
    /// </summary>
    public sealed class W3C
    {
        private string[] _fields = ["date", "time", "s-ip", "cs-method", "cs-uri-stem", "cs-uri-query", "s-port", "cs-username", "c-ip",
            "cs(User-Agent)", "cs(Referer)", "sc-status", "sc-substatus", "sc-win32-status", "time-taken"];

        /// <summary>Un en-tête « #Fields: » a été lu : le fichier est un journal W3C.</summary>
        public bool HasFields { get; private set; }

        public ParsedEntry? Parse(string line)
        {
            if (line.StartsWith("#Fields:", StringComparison.Ordinal))
            {
                _fields = line[8..].Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                HasFields = true;
                return null;
            }
            if (line.StartsWith('#') || line.Length == 0) return null;
            var parts = line.Split(' ');
            if (parts.Length < _fields.Length) return null;
            string? F(string name)
            {
                var i = Array.IndexOf(_fields, name);
                return i < 0 || parts[i] == "-" ? null : parts[i];
            }
            var e = new ParsedEntry();
            if (DateTime.TryParse($"{F("date")} {F("time")}", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t))
                e.Ts = DateTime.SpecifyKind(t, DateTimeKind.Utc); // IIS écrit en UTC
            var status = int.TryParse(F("sc-status"), out var s) ? s : 0;
            var taken = double.TryParse(F("time-taken"), CultureInfo.InvariantCulture, out var ms) ? ms : 0;
            var method = F("cs-method") ?? "GET";
            var path = F("cs-uri-stem") ?? "/";
            var agent = F("cs(User-Agent)")?.Replace('+', ' ');
            e.Http = new HttpEntry(method, path, F("cs-uri-query"), status, taken, F("c-ip"), agent, F("cs-host") ?? F("s-ip"));
            e.Host = F("s-computername");
            e.Severity = status >= 500 ? 17 : status >= 400 ? 13 : 9;
            e.Body = $"{method} {path} {status} {taken.ToString(CultureInfo.InvariantCulture)} ms";
            if (F("sc-substatus") is { } sub && sub != "0") e.Attributes["iis.substatus"] = sub;
            if (F("sc-win32-status") is { } win && win != "0") e.Attributes["iis.win32_status"] = win;
            return e;
        }
    }
}
