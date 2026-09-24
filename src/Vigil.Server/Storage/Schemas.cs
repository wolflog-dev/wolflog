using DuckDB.NET.Data;
using Vigil.Server.Ingestion;

namespace Vigil.Server.Storage;

public sealed class LogRow
{
    public DateTime Ts;
    public string Service = "";
    public string? Host;
    public string? Env;
    public string? Version;
    public string? InstanceId;
    public byte Severity;
    public string Body = "";
    public string? TraceId;
    public string? SpanId;
    public string? Category;
    public string? ExceptionType;
    public string? ExceptionMessage;
    public string? ExceptionStack;
    public string? Fingerprint;
    public bool IsCrash;
    public string Attributes = "{}";
    public string Resource = "{}";
}

public sealed class SpanRow
{
    public DateTime Ts;
    public long DurationNs;
    public string TraceId = "";
    public string SpanId = "";
    public string? ParentSpanId;
    public string Service = "";
    public string? Host;
    public string? Env;
    public string? Version;
    public string Name = "";
    public byte Kind;
    public byte StatusCode;
    public string? StatusMessage;
    public string? Scope;
    public string Attributes = "{}";
    public string Events = "[]";
    public string Resource = "{}";
}

public sealed class MetricRow
{
    public DateTime Ts;
    public string Service = "";
    public string? Host;
    public string? Env;
    public string Name = "";
    public string? Unit;
    public string? Description;
    /// <summary>1 gauge, 2 sum, 3 histogram, 4 exponential histogram, 5 summary.</summary>
    public byte Type;
    /// <summary>1 delta, 2 cumulative.</summary>
    public byte Temporality;
    public bool Monotonic;
    public double? Value;
    public long? Count;
    public double? Sum;
    public double? Min;
    public double? Max;
    public string? Buckets;
    public string Attributes = "{}";
}

/// <summary>Décrit comment un type de signal est stocké : colonnes, écriture, indexation, décodage du WAL.</summary>
public abstract class SignalSchema<TRow>
{
    public abstract string Name { get; }
    /// <summary>Définition des colonnes (DDL DuckDB).</summary>
    public abstract string Columns { get; }
    public abstract void Append(IDuckDBAppenderRow row, TRow r);
    public abstract void Index(SegmentIndex index, TRow r);
    public abstract List<TRow> Decode(ReadOnlySpan<byte> payload);
    public virtual bool HasTextIndex => false;

    public string ColumnNames => field ??= string.Join(", ",
        Columns.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(c => c.Split(' ')[0]));
}

internal static class AppendExtensions
{
    extension(IDuckDBAppenderRow row)
    {
        /// <summary>Chaîne ou NULL.</summary>
        public IDuckDBAppenderRow Str(string? value) =>
            value is null ? row.AppendNullValue() : row.AppendValue(value);
    }
}

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

public sealed class MetricSchema : SignalSchema<MetricRow>
{
    public static readonly MetricSchema Instance = new();
    public override string Name => "metrics";

    public override string Columns => """
        ts TIMESTAMP, service VARCHAR, host VARCHAR, env VARCHAR, name VARCHAR, unit VARCHAR, description VARCHAR,
        type UTINYINT, temporality UTINYINT, monotonic BOOLEAN, value DOUBLE, count BIGINT, sum DOUBLE,
        min DOUBLE, max DOUBLE, buckets VARCHAR, attributes VARCHAR
        """;

    public override void Append(IDuckDBAppenderRow row, MetricRow r)
    {
        row.AppendValue(r.Ts).AppendValue(r.Service).Str(r.Host).Str(r.Env).AppendValue(r.Name).Str(r.Unit).Str(r.Description)
            .AppendValue(r.Type).AppendValue(r.Temporality).AppendValue(r.Monotonic).AppendValue(r.Value).AppendValue(r.Count)
            .AppendValue(r.Sum).AppendValue(r.Min).AppendValue(r.Max).Str(r.Buckets).AppendValue(r.Attributes)
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
