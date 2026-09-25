using DuckDB.NET.Data;

namespace Wolflog.Server.Storage;

public sealed class MetricSchema : SignalSchema<MetricRow>
{
    public static readonly MetricSchema Instance = new();
    public override string Name => "metrics";

    public override string Columns => """
        ts TIMESTAMP, service VARCHAR, host VARCHAR, env VARCHAR, name VARCHAR, unit VARCHAR, description VARCHAR,
        type UTINYINT, temporality UTINYINT, monotonic BOOLEAN, value DOUBLE, count BIGINT, sum DOUBLE,
        min DOUBLE, max DOUBLE, buckets VARCHAR, attributes VARCHAR, exemplars VARCHAR
        """;

    public override void Append(IDuckDBAppenderRow row, MetricRow r)
    {
        row.AppendValue(r.Ts).AppendValue(r.Service).Str(r.Host).Str(r.Env).AppendValue(r.Name).Str(r.Unit).Str(r.Description)
            .AppendValue(r.Type).AppendValue(r.Temporality).AppendValue(r.Monotonic).AppendValue(r.Value).AppendValue(r.Count)
            .AppendValue(r.Sum).AppendValue(r.Min).AppendValue(r.Max).Str(r.Buckets).AppendValue(r.Attributes).Str(r.Exemplars)
            .EndRow();
    }

    public override void Index(SegmentIndex index, MetricRow r)
    {
        index.AddTimestamp(r.Ts);
        index.AddService(r.Service);
    }

    public override List<MetricRow> Decode(ReadOnlySpan<byte> payload) =>
        OtlpConverter.ConvertMetrics(OpenTelemetry.Proto.Collector.Metrics.V1.ExportMetricsServiceRequest.Parser.ParseFrom(payload));
}
