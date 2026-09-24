using System.Buffers;
using System.Text;
using System.Text.Json;
using Google.Protobuf;
using Google.Protobuf.Collections;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Metrics.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Metrics.V1;
using Vigil.Server.Storage;

namespace Vigil.Server.Ingestion;

/// <summary>Convertit les messages OTLP (protobuf) en lignes de stockage.</summary>
public static class OtlpConverter
{
    private readonly record struct ResourceInfo(string Service, string? Host, string? Env, string? Version, string? InstanceId, string Json);

    [ThreadStatic] private static ArrayBufferWriter<byte>? t_buffer;
    [ThreadStatic] private static Utf8JsonWriter? t_writer;

    // ---------- Logs ----------

    public static List<LogRow> ConvertLogs(ExportLogsServiceRequest request)
    {
        var count = 0;
        foreach (var rl in request.ResourceLogs)
            foreach (var sl in rl.ScopeLogs) count += sl.LogRecords.Count;
        var rows = new List<LogRow>(count);

        foreach (var rl in request.ResourceLogs)
        {
            var res = ReadResource(rl.Resource?.Attributes);
            foreach (var sl in rl.ScopeLogs)
            {
                var category = NullIfEmpty(sl.Scope?.Name);
                foreach (var lr in sl.LogRecords)
                {
                    var row = new LogRow
                    {
                        Ts = ToDateTime(lr.TimeUnixNano != 0 ? lr.TimeUnixNano : lr.ObservedTimeUnixNano),
                        Service = res.Service,
                        Host = res.Host,
                        Env = res.Env,
                        Version = res.Version,
                        InstanceId = res.InstanceId,
                        Severity = SeverityOf((int)lr.SeverityNumber, lr.SeverityText),
                        Body = AnyToString(lr.Body),
                        TraceId = HexId(lr.TraceId),
                        SpanId = HexId(lr.SpanId),
                        Category = category,
                        Resource = res.Json,
                    };

                    var w = BeginJson();
                    w.WriteStartObject();
                    foreach (var kv in lr.Attributes)
                    {
                        switch (kv.Key)
                        {
                            case "exception.type": row.ExceptionType = Scalar(kv.Value); continue;
                            case "exception.message": row.ExceptionMessage = Scalar(kv.Value); continue;
                            case "exception.stacktrace": row.ExceptionStack = Scalar(kv.Value); continue;
                            case "vigil.crash": row.IsCrash = kv.Value?.BoolValue == true || kv.Value?.StringValue == "true"; continue;
                        }
                        w.WritePropertyName(kv.Key);
                        WriteAny(w, kv.Value);
                    }
                    if (!string.IsNullOrEmpty(lr.EventName))
                    {
                        w.WriteString("event.name", lr.EventName);
                    }
                    w.WriteEndObject();
                    row.Attributes = EndJson();

                    if (!string.IsNullOrEmpty(row.ExceptionType))
                    {
                        row.ExceptionType = FullTypeName(row.ExceptionType, row.ExceptionStack);
                        row.Fingerprint = Fingerprint.Compute(row.ExceptionType, row.ExceptionMessage, row.ExceptionStack);
                        if (row.Body.Length == 0) row.Body = $"{row.ExceptionType}: {row.ExceptionMessage}";
                    }
                    rows.Add(row);
                }
            }
        }
        return rows;
    }

    /// <summary>
    /// Le SDK .NET envoie le nom court ("InvalidOperationException") ; la stack trace commence par le nom complet
    /// ("System.InvalidOperationException: message") : on le récupère.
    /// </summary>
    public static string FullTypeName(string type, string? stack)
    {
        if (type.Contains('.') || string.IsNullOrEmpty(stack)) return type;
        var colon = stack.IndexOf(':');
        var newline = stack.IndexOf('\n');
        if (colon <= 0 || (newline >= 0 && newline < colon)) return type;
        var candidate = stack[..colon].Trim();
        return candidate.EndsWith("." + type, StringComparison.Ordinal) && !candidate.Contains(' ') ? candidate : type;
    }

    public static byte SeverityOf(int number, string? text)
    {
        if (number is > 0 and <= 24) return (byte)number;
        return (text ?? "").ToLowerInvariant() switch
        {
            "trace" or "verbose" => 1,
            "debug" => 5,
            "info" or "information" => 9,
            "warn" or "warning" => 13,
            "error" or "err" => 17,
            "fatal" or "critical" or "crit" => 21,
            _ => 9,
        };
    }

    // ---------- Traces ----------

    public static List<SpanRow> ConvertSpans(ExportTraceServiceRequest request)
    {
        var rows = new List<SpanRow>();
        foreach (var rs in request.ResourceSpans)
        {
            var res = ReadResource(rs.Resource?.Attributes);
            foreach (var ss in rs.ScopeSpans)
            {
                var scope = NullIfEmpty(ss.Scope?.Name);
                foreach (var s in ss.Spans)
                {
                    var row = new SpanRow
                    {
                        Ts = ToDateTime(s.StartTimeUnixNano),
                        DurationNs = s.EndTimeUnixNano > s.StartTimeUnixNano ? (long)(s.EndTimeUnixNano - s.StartTimeUnixNano) : 0,
                        TraceId = HexId(s.TraceId) ?? "",
                        SpanId = HexId(s.SpanId) ?? "",
                        ParentSpanId = HexId(s.ParentSpanId),
                        Service = res.Service,
                        Host = res.Host,
                        Env = res.Env,
                        Version = res.Version,
                        Name = s.Name,
                        Kind = (byte)s.Kind,
                        StatusCode = (byte)(s.Status?.Code ?? 0),
                        StatusMessage = NullIfEmpty(s.Status?.Message),
                        Scope = scope,
                        Attributes = AttributesJson(s.Attributes),
                        Resource = res.Json,
                    };

                    if (s.Events.Count > 0)
                    {
                        var w = BeginJson();
                        w.WriteStartArray();
                        foreach (var e in s.Events)
                        {
                            w.WriteStartObject();
                            w.WriteString("name", e.Name);
                            w.WriteString("ts", ToDateTime(e.TimeUnixNano));
                            w.WritePropertyName("attributes");
                            WriteAttributes(w, e.Attributes);
                            w.WriteEndObject();
                        }
                        w.WriteEndArray();
                        row.Events = EndJson();
                    }
                    rows.Add(row);
                }
            }
        }
        return rows;
    }

    // ---------- Metrics ----------

    public static List<MetricRow> ConvertMetrics(ExportMetricsServiceRequest request)
    {
        var rows = new List<MetricRow>();
        foreach (var rm in request.ResourceMetrics)
        {
            var res = ReadResource(rm.Resource?.Attributes);
            foreach (var sm in rm.ScopeMetrics)
            {
                foreach (var m in sm.Metrics)
                {
                    MetricRow New(ulong ts, RepeatedField<KeyValue> attrs, byte type) => new()
                    {
                        Ts = ToDateTime(ts),
                        Service = res.Service,
                        Host = res.Host,
                        Env = res.Env,
                        Name = m.Name,
                        Unit = NullIfEmpty(m.Unit),
                        Description = NullIfEmpty(m.Description),
                        Type = type,
                        Attributes = AttributesJson(attrs),
                    };

                    switch (m.DataCase)
                    {
                        case Metric.DataOneofCase.Gauge:
                            foreach (var p in m.Gauge.DataPoints)
                            {
                                var r = New(p.TimeUnixNano, p.Attributes, 1);
                                r.Value = NumberValue(p);
                                rows.Add(r);
                            }
                            break;
                        case Metric.DataOneofCase.Sum:
                            foreach (var p in m.Sum.DataPoints)
                            {
                                var r = New(p.TimeUnixNano, p.Attributes, 2);
                                r.Value = NumberValue(p);
                                r.Temporality = (byte)m.Sum.AggregationTemporality;
                                r.Monotonic = m.Sum.IsMonotonic;
                                rows.Add(r);
                            }
                            break;
                        case Metric.DataOneofCase.Histogram:
                            foreach (var p in m.Histogram.DataPoints)
                            {
                                var r = New(p.TimeUnixNano, p.Attributes, 3);
                                r.Temporality = (byte)m.Histogram.AggregationTemporality;
                                r.Count = (long)p.Count;
                                r.Sum = p.HasSum ? p.Sum : null;
                                r.Min = p.HasMin ? p.Min : null;
                                r.Max = p.HasMax ? p.Max : null;
                                r.Value = p.Count > 0 && p.HasSum ? p.Sum / p.Count : null;
                                r.Buckets = BucketsJson(p.ExplicitBounds, p.BucketCounts);
                                rows.Add(r);
                            }
                            break;
                        case Metric.DataOneofCase.ExponentialHistogram:
                            foreach (var p in m.ExponentialHistogram.DataPoints)
                            {
                                var r = New(p.TimeUnixNano, p.Attributes, 4);
                                r.Temporality = (byte)m.ExponentialHistogram.AggregationTemporality;
                                r.Count = (long)p.Count;
                                r.Sum = p.HasSum ? p.Sum : null;
                                r.Min = p.HasMin ? p.Min : null;
                                r.Max = p.HasMax ? p.Max : null;
                                r.Value = p.Count > 0 && p.HasSum ? p.Sum / p.Count : null;
                                rows.Add(r);
                            }
                            break;
                        case Metric.DataOneofCase.Summary:
                            foreach (var p in m.Summary.DataPoints)
                            {
                                var r = New(p.TimeUnixNano, p.Attributes, 5);
                                r.Count = (long)p.Count;
                                r.Sum = p.Sum;
                                r.Value = p.Count > 0 ? p.Sum / p.Count : null;
                                var w = BeginJson();
                                w.WriteStartObject();
                                foreach (var q in p.QuantileValues) w.WriteNumber(q.Quantile.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture), q.Value);
                                w.WriteEndObject();
                                r.Buckets = EndJson();
                                rows.Add(r);
                            }
                            break;
                    }
                }
            }
        }
        return rows;
    }

    private static double NumberValue(NumberDataPoint p) =>
        p.ValueCase == NumberDataPoint.ValueOneofCase.AsInt ? p.AsInt : p.AsDouble;

    private static string BucketsJson(RepeatedField<double> bounds, RepeatedField<ulong> counts)
    {
        var w = BeginJson();
        w.WriteStartObject();
        w.WriteStartArray("bounds");
        foreach (var b in bounds) w.WriteNumberValue(b);
        w.WriteEndArray();
        w.WriteStartArray("counts");
        foreach (var c in counts) w.WriteNumberValue(c);
        w.WriteEndArray();
        w.WriteEndObject();
        return EndJson();
    }

    // ---------- Utilitaires ----------

    private static ResourceInfo ReadResource(RepeatedField<KeyValue>? attributes)
    {
        string service = "unknown", json = "{}";
        string? host = null, env = null, version = null, instance = null;
        if (attributes is { Count: > 0 })
        {
            foreach (var kv in attributes)
            {
                switch (kv.Key)
                {
                    case "service.name": service = AnyToString(kv.Value); break;
                    case "host.name": host = AnyToString(kv.Value); break;
                    case "deployment.environment.name":
                    case "deployment.environment": env = AnyToString(kv.Value); break;
                    case "service.version": version = AnyToString(kv.Value); break;
                    case "service.instance.id": instance = AnyToString(kv.Value); break;
                }
            }
            json = AttributesJson(attributes);
        }
        if (string.IsNullOrEmpty(service)) service = "unknown";
        return new ResourceInfo(service, host, env, version, instance, json);
    }

    public static DateTime ToDateTime(ulong unixNanos)
    {
        if (unixNanos == 0) return DateTime.UtcNow;
        return DateTime.UnixEpoch.AddTicks((long)(unixNanos / 100));
    }

    private static string? HexId(ByteString id)
    {
        if (id.IsEmpty) return null;
        var span = id.Span;
        if (!span.ContainsAnyExcept((byte)0)) return null;
        return Convert.ToHexStringLower(span);
    }

    private static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    // Version sans writer JSON : utilisable pendant l'écriture d'un autre objet JSON.
    private static string Scalar(AnyValue? v) =>
        v?.ValueCase == AnyValue.ValueOneofCase.StringValue ? v.StringValue : v?.ToString() ?? "";

    public static string AnyToString(AnyValue? v)
    {
        if (v is null) return "";
        switch (v.ValueCase)
        {
            case AnyValue.ValueOneofCase.StringValue: return v.StringValue;
            case AnyValue.ValueOneofCase.BoolValue: return v.BoolValue ? "true" : "false";
            case AnyValue.ValueOneofCase.IntValue: return v.IntValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
            case AnyValue.ValueOneofCase.DoubleValue: return v.DoubleValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
            case AnyValue.ValueOneofCase.BytesValue: return Convert.ToBase64String(v.BytesValue.Span);
            case AnyValue.ValueOneofCase.None: return "";
            default:
                var w = BeginJson();
                WriteAny(w, v);
                return EndJson();
        }
    }

    private static string AttributesJson(RepeatedField<KeyValue> attributes)
    {
        if (attributes.Count == 0) return "{}";
        var w = BeginJson();
        WriteAttributes(w, attributes);
        return EndJson();
    }

    private static void WriteAttributes(Utf8JsonWriter w, RepeatedField<KeyValue> attributes)
    {
        w.WriteStartObject();
        foreach (var kv in attributes)
        {
            w.WritePropertyName(kv.Key);
            WriteAny(w, kv.Value);
        }
        w.WriteEndObject();
    }

    private static void WriteAny(Utf8JsonWriter w, AnyValue? v)
    {
        if (v is null) { w.WriteNullValue(); return; }
        switch (v.ValueCase)
        {
            case AnyValue.ValueOneofCase.StringValue: w.WriteStringValue(v.StringValue); break;
            case AnyValue.ValueOneofCase.BoolValue: w.WriteBooleanValue(v.BoolValue); break;
            case AnyValue.ValueOneofCase.IntValue: w.WriteNumberValue(v.IntValue); break;
            case AnyValue.ValueOneofCase.DoubleValue:
                if (double.IsFinite(v.DoubleValue)) w.WriteNumberValue(v.DoubleValue);
                else w.WriteStringValue(v.DoubleValue.ToString(System.Globalization.CultureInfo.InvariantCulture));
                break;
            case AnyValue.ValueOneofCase.BytesValue: w.WriteBase64StringValue(v.BytesValue.Span); break;
            case AnyValue.ValueOneofCase.ArrayValue:
                w.WriteStartArray();
                foreach (var item in v.ArrayValue.Values) WriteAny(w, item);
                w.WriteEndArray();
                break;
            case AnyValue.ValueOneofCase.KvlistValue:
                w.WriteStartObject();
                foreach (var kv in v.KvlistValue.Values)
                {
                    w.WritePropertyName(kv.Key);
                    WriteAny(w, kv.Value);
                }
                w.WriteEndObject();
                break;
            default: w.WriteNullValue(); break;
        }
    }

    private static Utf8JsonWriter BeginJson()
    {
        t_buffer ??= new ArrayBufferWriter<byte>(1024);
        t_buffer.ResetWrittenCount();
        if (t_writer is null) t_writer = new Utf8JsonWriter(t_buffer, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        else t_writer.Reset(t_buffer);
        return t_writer;
    }

    private static string EndJson()
    {
        t_writer!.Flush();
        return Encoding.UTF8.GetString(t_buffer!.WrittenSpan);
    }
}
