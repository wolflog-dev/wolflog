using DuckDB.NET.Data;

namespace Wolflog.Server.Storage;

public sealed class SpanSchema : SignalSchema<SpanRow>
{
    public static readonly SpanSchema Instance = new();
    public override string Name => "spans";

    public override string Columns => """
        ts TIMESTAMP, duration_ns BIGINT, trace_id VARCHAR, span_id VARCHAR, parent_span_id VARCHAR,
        service VARCHAR, host VARCHAR, env VARCHAR, version VARCHAR, name VARCHAR, kind UTINYINT,
        status_code UTINYINT, status_message VARCHAR, scope VARCHAR, attributes VARCHAR, events VARCHAR, resource VARCHAR
        """;

    public override void Append(IDuckDBAppenderRow row, SpanRow r)
    {
        row.AppendValue(r.Ts).AppendValue(r.DurationNs).AppendValue(r.TraceId).AppendValue(r.SpanId).Str(r.ParentSpanId)
            .AppendValue(r.Service).Str(r.Host).Str(r.Env).Str(r.Version).AppendValue(r.Name).AppendValue(r.Kind)
            .AppendValue(r.StatusCode).Str(r.StatusMessage).Str(r.Scope).AppendValue(r.Attributes).AppendValue(r.Events)
            .AppendValue(r.Resource)
            .EndRow();
    }

    public override void Index(SegmentIndex index, SpanRow r)
    {
        index.AddTimestamp(r.Ts);
        index.AddService(r.Service);
        if (r.StatusCode == 2) index.HasExceptions = true;
        index.TraceIds.Add(r.TraceId);
    }

    public override List<SpanRow> Decode(ReadOnlySpan<byte> payload) =>
        OtlpConverter.ConvertSpans(OpenTelemetry.Proto.Collector.Trace.V1.ExportTraceServiceRequest.Parser.ParseFrom(payload));
}
