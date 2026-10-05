using DuckDB.NET.Data;

namespace Wolflog.Server.Analytics;

/// <summary>Stockage de l'audience web : même moteur que les logs (WAL → DuckDB → Parquet), une seule table dénormalisée.</summary>
public sealed class AnalyticsSchema : SignalSchema<AnalyticsRow>
{
    public static readonly AnalyticsSchema Instance = new();
    private static readonly JsonSerializerOptions Json = new() { IncludeFields = true };

    public override string Name => "analytics";

    /// <summary>2 : pseudonyme des utilisateurs identifiés (user_key).</summary>
    public override int Version => 2;

    public override string Columns => """
        ts TIMESTAMP, service VARCHAR, env VARCHAR, kind UTINYINT, visitor VARCHAR, visit VARCHAR, path VARCHAR, title VARCHAR,
        hostname VARCHAR, referrer_domain VARCHAR, utm_source VARCHAR, utm_medium VARCHAR, utm_campaign VARCHAR,
        event_name VARCHAR, event_data VARCHAR, browser VARCHAR, os VARCHAR, device VARCHAR, screen VARCHAR, language VARCHAR,
        country VARCHAR, source VARCHAR, vw INTEGER, vh INTEGER, doc_h INTEGER, x INTEGER, y INTEGER, selector VARCHAR,
        label VARCHAR, rage BOOLEAN, dead BOOLEAN, depth UTINYINT, user_key VARCHAR
        """;

    public override void Append(IDuckDBAppenderRow row, AnalyticsRow r)
    {
        row.AppendValue(r.Ts).AppendValue(r.Service).Str(r.Env).AppendValue(r.Kind).AppendValue(r.Visitor).AppendValue(r.Visit)
            .AppendValue(r.Path).Str(r.Title).Str(r.Hostname).Str(r.ReferrerDomain).Str(r.UtmSource).Str(r.UtmMedium).Str(r.UtmCampaign)
            .Str(r.EventName).Str(r.EventData).Str(r.Browser).Str(r.Os).Str(r.Device).Str(r.Screen).Str(r.Language)
            .Str(r.Country).AppendValue(r.Source).AppendValue(r.Vw).AppendValue(r.Vh).AppendValue(r.DocH).AppendValue(r.X).AppendValue(r.Y)
            .Str(r.Selector).Str(r.Label).AppendValue(r.Rage).AppendValue(r.Dead).AppendValue(r.Depth).Str(r.UserKey)
            .EndRow();
    }

    public override void Index(SegmentIndex index, AnalyticsRow r)
    {
        index.AddTimestamp(r.Ts);
        index.AddService(r.Service);
    }

    /// <summary>Le WAL contient les lignes déjà normalisées, sérialisées en JSON.</summary>
    public static byte[] Encode(List<AnalyticsRow> rows) => JsonSerializer.SerializeToUtf8Bytes(rows, Json);

    public override List<AnalyticsRow> Decode(ReadOnlySpan<byte> payload) =>
        JsonSerializer.Deserialize<List<AnalyticsRow>>(payload, Json) ?? [];
}
