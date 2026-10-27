namespace Wolflog.Server.Query;

/// <summary>
/// Barre de recherche des requêtes HTTP, traduite en conditions SQL sur les colonnes de la projection HTTP
/// (method, route, target, host, service, status, status_code, duration_ns, kind, req_body, res_body, attributes) :
/// <code>
///   commande                  mot cherché dans le chemin, la route, l'hôte et les corps de requête et de réponse
///   "paiement refusé"         phrase exacte
///   -healthz                  exclusion (aussi -route:/health*)
///   method:POST,PUT           méthode (liste : l'une ou l'autre)
///   status:5xx  status:404  status:400-499  status:>=500  status:error
///   route:/api/orders/*       route (* : n'importe quels caractères ; sans * : route exacte)
///   path:/commandes           chemin ou URL (contient)
///   host:api.stripe.com       hôte (appels sortants : API externe)
///   service:boutique-*        service émetteur ou récepteur
///   type:api  type:page  type:static  type:health
///   body:"carte refusée"      corps de la requête ou de la réponse ; request: / response: pour l'un des deux
///   header:application/json   en-têtes et autres attributs
///   duration:>500ms  duration:&lt;2s
///   trace:4bf92f35…           trace
///   user.id:42                tout autre attribut (clé exacte)
/// </code>
/// Les champs ont des alias français (méthode, statut, chemin, hôte, corps, requête, réponse, en-tête, durée).
/// </summary>
public static class HttpSearch
{
    /// <summary>Types de route (colonne kind) et leurs noms acceptés.</summary>
    public static readonly IReadOnlyDictionary<string, string> Kinds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["api"] = "api", ["page"] = "page", ["pages"] = "page", ["static"] = "static", ["statique"] = "static", ["fichier"] = "static",
        ["fichiers"] = "static", ["asset"] = "static", ["assets"] = "static", ["health"] = "health", ["sante"] = "health", ["santé"] = "health",
    };

    /// <summary>Conditions SQL (à combiner par AND) ; une recherche vide n'en produit aucune.</summary>
    public static List<string> Conditions(string? text)
    {
        var conditions = new List<string>();
        if (string.IsNullOrWhiteSpace(text)) return conditions;
        foreach (var (raw, quoted, negatedPhrase) in Tokenize(text))
        {
            var token = raw;
            var negated = negatedPhrase;
            if (!negated && !quoted && token.Length > 1 && token[0] == '-')
            {
                negated = true;
                token = token[1..];
            }
            string? condition;
            var colon = quoted ? -1 : token.IndexOf(':');
            if (colon > 0 && colon < token.Length - 1)
                condition = Field(Normalize(token[..colon]), token[(colon + 1)..].Trim('"'));
            else
                condition = FreeText(token.Trim('"'));
            if (condition is null) continue;
            // NULL (route absente, corps non capturé) : ni « vrai » ni « faux » ; l'exclusion les garde.
            conditions.Add(negated ? $"NOT coalesce(({condition}), false)" : $"coalesce(({condition}), false)");
        }
        return conditions;
    }

    private static string FreeText(string term)
    {
        if (term.Length == 0) return "true";
        var p = Contains(term);
        return $"(target ILIKE {p} ESCAPE '\\' OR route ILIKE {p} ESCAPE '\\' OR host ILIKE {p} ESCAPE '\\' "
            + $"OR req_body ILIKE {p} ESCAPE '\\' OR res_body ILIKE {p} ESCAPE '\\')";
    }

    private static string? Field(string key, string value)
    {
        switch (key)
        {
            case "method" or "methode" or "verb":
                return $"upper(method) IN {Sql.List(value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(v => v.ToUpperInvariant()))}";
            case "status" or "statut" or "code":
                return AnyOf(value, Status);
            case "route":
                return AnyOf(value, v => Match("route", v, exact: true));
            case "path" or "chemin" or "url" or "target":
                return AnyOf(value, v => Match("target", v, exact: false));
            case "host" or "hote" or "domain" or "domaine":
                return AnyOf(value, v => Match("host", v, exact: true));
            case "service":
                return AnyOf(value, v => Match("service", v, exact: true));
            case "type" or "kind":
                var kinds = value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(v => Kinds.TryGetValue(v, out var k) ? k : null).OfType<string>().ToList();
                return kinds.Count == 0 ? "false" : $"kind IN {Sql.List(kinds)}";
            case "body" or "corps":
                return $"(req_body ILIKE {Contains(value)} ESCAPE '\\' OR res_body ILIKE {Contains(value)} ESCAPE '\\')";
            case "request" or "requete" or "req":
                return $"req_body ILIKE {Contains(value)} ESCAPE '\\'";
            case "response" or "reponse" or "res":
                return $"res_body ILIKE {Contains(value)} ESCAPE '\\'";
            case "header" or "headers" or "entete" or "en-tete" or "attribute" or "attribut":
                return $"attributes ILIKE {Contains(value)} ESCAPE '\\'";
            case "duration" or "duree" or "latency":
                return Duration(value);
            case "trace" or "traceid":
                return $"trace_id = {Sql.Str(value.ToLowerInvariant())}";
            default:
                // Attribut quelconque : clé exacte, valeur exacte ou avec *.
                return AnyOf(value, v => Match($"json_extract_string(attributes, {Sql.Str("$.\"" + key.Replace("\"", "") + "\"")})", v, exact: true));
        }
    }

    /// <summary>Liste « a,b » : l'une ou l'autre valeur.</summary>
    private static string AnyOf(string value, Func<string, string?> one)
    {
        var parts = value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(one).OfType<string>().ToList();
        return parts.Count == 0 ? "false" : parts.Count == 1 ? parts[0] : "(" + string.Join(" OR ", parts) + ")";
    }

    /// <summary>Valeur avec * : motif ; sinon égalité (exact) ou contient, sans tenir compte de la casse.</summary>
    private static string Match(string column, string value, bool exact)
    {
        if (value.Contains('*')) return $"{column} ILIKE {Pattern(value)} ESCAPE '\\'";
        return exact ? $"lower({column}) = {Sql.Str(value.ToLowerInvariant())}" : $"{column} ILIKE {Contains(value)} ESCAPE '\\'";
    }

    private static string? Status(string v)
    {
        var s = v.ToLowerInvariant();
        if (s is "error" or "errors" or "erreur" or "erreurs") return "(status >= 500 OR status_code = 2)";
        if (s.Length == 3 && char.IsDigit(s[0]) && s[1..] == "xx") return $"status BETWEEN {s[0]}00 AND {s[0]}99";
        if (s.Split('-') is [var lo, var hi] && int.TryParse(lo, out var a) && int.TryParse(hi, out var b)) return $"status BETWEEN {a} AND {b}";
        foreach (var op in new[] { ">=", "<=", ">", "<" })
            if (s.StartsWith(op) && int.TryParse(s[op.Length..], out var n)) return $"status {op} {n}";
        return int.TryParse(s, out var code) ? $"status = {code}" : null;
    }

    private static string? Duration(string v)
    {
        var s = v.Trim().ToLowerInvariant().Replace(',', '.');
        var op = new[] { ">=", "<=", ">", "<" }.FirstOrDefault(s.StartsWith) ?? ">=";
        s = s.StartsWith(op) ? s[op.Length..] : s;
        var (number, factor) = s.EndsWith("ms") ? (s[..^2], 1d) : s.EndsWith("min") ? (s[..^3], 60_000d) : s.EndsWith('s') ? (s[..^1], 1000d) : (s, 1d);
        if (!double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)) return null;
        return $"duration_ns {op} {(long)(value * factor * 1_000_000)}";
    }

    private static string Contains(string term) => Sql.Like(term);

    /// <summary>Motif LIKE : * = n'importe quels caractères, % et _ pris à la lettre.</summary>
    private static string Pattern(string value) =>
        Sql.Str(value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace("*", "%"));

    /// <summary>
    /// Clé en minuscules et sans accents : « Méthode » = « methode ». Table explicite : le serveur tourne en mode
    /// « globalisation invariante », où la normalisation Unicode ne retire pas les accents.
    /// </summary>
    private static string Normalize(string key) => new(key.ToLowerInvariant().Select(c => c switch
    {
        'à' or 'â' or 'ä' => 'a',
        'é' or 'è' or 'ê' or 'ë' => 'e',
        'î' or 'ï' => 'i',
        'ô' or 'ö' => 'o',
        'ù' or 'û' or 'ü' => 'u',
        'ç' => 'c',
        _ => c,
    }).ToArray());

    /// <summary>Mots, phrases entre guillemets, et clé:"valeur avec espaces".</summary>
    private static IEnumerable<(string Value, bool Quoted, bool Negated)> Tokenize(string text)
    {
        var sb = new StringBuilder();
        var inQuotes = false;
        var phraseQuote = false; // guillemet ouvert en début de mot (ou après « - ») : phrase, sinon clé:"valeur"
        var phrase = false;
        var negated = false;
        foreach (var c in text)
        {
            if (c == '"')
            {
                if (!inQuotes && sb.Length == 1 && sb[0] == '-')
                {
                    sb.Clear();
                    negated = true;
                }
                if (!inQuotes) phraseQuote = sb.Length == 0;
                else if (phraseQuote) phrase = true;
                inQuotes = !inQuotes;
                continue;
            }
            if (char.IsWhiteSpace(c) && !inQuotes)
            {
                if (sb.Length > 0) yield return (sb.ToString(), phrase, negated);
                sb.Clear();
                phrase = negated = false;
                continue;
            }
            sb.Append(c);
        }
        if (sb.Length > 0) yield return (sb.ToString(), phrase, negated);
    }
}
