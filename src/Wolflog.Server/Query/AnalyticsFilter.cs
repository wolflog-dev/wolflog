namespace Wolflog.Server.Query;

/// <summary>Filtres de l'audience : service et dimensions (page, référent, pays…), cumulables.</summary>
public sealed class AnalyticsFilter
{
    /// <summary>Clé publique → colonne SQL (liste blanche).</summary>
    public static readonly IReadOnlyDictionary<string, string> Dimensions = new Dictionary<string, string>
    {
        ["page"] = "path", ["title"] = "title", ["host"] = "hostname", ["referrer"] = "referrer_domain",
        ["browser"] = "browser", ["os"] = "os", ["device"] = "device", ["country"] = "country", ["language"] = "language",
        ["screen"] = "screen", ["event"] = "event_name", ["source"] = "source",
        ["utm_source"] = "utm_source", ["utm_medium"] = "utm_medium", ["utm_campaign"] = "utm_campaign",
    };

    public string? Service { get; init; }
    public IReadOnlyDictionary<string, string> Values { get; init; } = new Dictionary<string, string>();

    /// <summary>Filtres lus dans la query string : <c>service=…&amp;f.page=/tarifs&amp;f.country=FR</c>.</summary>
    public static AnalyticsFilter From(IQueryCollection query) => new()
    {
        Service = query["service"].ToString() is { Length: > 0 } s ? s : null,
        Values = query.Where(kv => kv.Key.StartsWith("f.", StringComparison.Ordinal) && Dimensions.ContainsKey(kv.Key[2..]))
            .ToDictionary(kv => kv.Key[2..], kv => kv.Value.ToString()),
    };
}
