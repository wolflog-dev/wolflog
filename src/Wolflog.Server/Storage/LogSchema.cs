using DuckDB.NET.Data;

namespace Wolflog.Server.Storage;

public sealed class LogSchema : SignalSchema<LogRow>
{
    public static readonly LogSchema Instance = new();
    public override string Name => "logs";
    public override bool HasTextIndex => true;

    public override string Columns => """
        ts TIMESTAMP, service VARCHAR, host VARCHAR, env VARCHAR, version VARCHAR, instance_id VARCHAR,
        severity UTINYINT, body VARCHAR, trace_id VARCHAR, span_id VARCHAR, category VARCHAR,
        exception_type VARCHAR, exception_message VARCHAR, exception_stack VARCHAR, fingerprint VARCHAR,
        is_crash BOOLEAN, attributes VARCHAR, resource VARCHAR
        """;

    public override void Append(IDuckDBAppenderRow row, LogRow r)
    {
        row.AppendValue(r.Ts).AppendValue(r.Service).Str(r.Host).Str(r.Env).Str(r.Version).Str(r.InstanceId)
            .AppendValue(r.Severity).AppendValue(r.Body).Str(r.TraceId).Str(r.SpanId).Str(r.Category)
            .Str(r.ExceptionType).Str(r.ExceptionMessage).Str(r.ExceptionStack).Str(r.Fingerprint)
            .AppendValue(r.IsCrash).AppendValue(r.Attributes).AppendValue(r.Resource)
            .EndRow();
    }

    public override void Index(SegmentIndex index, LogRow r)
    {
        index.AddTimestamp(r.Ts);
        index.AddService(r.Service);
        if (r.Severity > index.MaxSeverity) index.MaxSeverity = r.Severity;
        if (r.Fingerprint != null) index.HasExceptions = true;
        index.TraceIds.Add(r.TraceId);
        index.Text ??= new TrigramSet();
        index.Text.AddText(r.Body);
        index.Text.AddText(r.ExceptionMessage);
        index.Text.AddText(r.ExceptionType);
        index.Text.AddText(r.Category);
    }

    public override List<LogRow> Decode(ReadOnlySpan<byte> payload) =>
        OtlpConverter.ConvertLogs(OpenTelemetry.Proto.Collector.Logs.V1.ExportLogsServiceRequest.Parser.ParseFrom(payload));
}
