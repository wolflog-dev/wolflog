using Google.Protobuf;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Resource.V1;

namespace Wolflog.Client.Internal;

/// <summary>Construit les rapports de crash au format OTLP (ils passent par le même pipeline que les logs).</summary>
internal static class CrashReport
{
    public static ExportLogsServiceRequest Build(
        ServiceIdentity identity, DateTime timestamp, string exceptionType, string message, string? stackTrace,
        string body, IEnumerable<Breadcrumbs.Crumb> breadcrumbs, IEnumerable<KeyValuePair<string, string>>? extra = null,
        ActivityContext? activity = null)
    {
        var record = new LogRecord
        {
            TimeUnixNano = ToUnixNanos(timestamp),
            ObservedTimeUnixNano = ToUnixNanos(DateTime.UtcNow),
            SeverityNumber = SeverityNumber.Fatal,
            SeverityText = "Fatal",
            Body = new AnyValue { StringValue = body },
        };
        record.Attributes.Add(Kv("exception.type", exceptionType));
        record.Attributes.Add(Kv("exception.message", message));
        if (stackTrace != null) record.Attributes.Add(Kv("exception.stacktrace", stackTrace));
        record.Attributes.Add(new KeyValue { Key = "wolflog.crash", Value = new AnyValue { BoolValue = true } });
        record.Attributes.Add(Kv("wolflog.breadcrumbs", JsonSerializer.Serialize(breadcrumbs)));
        record.Attributes.Add(Kv("thread.name", Thread.CurrentThread.Name ?? $"#{Environment.CurrentManagedThreadId}"));
        if (extra != null)
            foreach (var kv in extra) record.Attributes.Add(Kv(kv.Key, kv.Value));

        if (activity is { } a && a.TraceId != default)
        {
            Span<byte> buffer = stackalloc byte[16];
            a.TraceId.CopyTo(buffer);
            record.TraceId = ByteString.CopyFrom(buffer);
            a.SpanId.CopyTo(buffer[..8]);
            record.SpanId = ByteString.CopyFrom(buffer[..8]);
        }

        var resource = new Resource();
        foreach (var kv in identity.Attributes())
        {
            resource.Attributes.Add(kv.Value is long l
                ? new KeyValue { Key = kv.Key, Value = new AnyValue { IntValue = l } }
                : Kv(kv.Key, kv.Value.ToString() ?? ""));
        }

        return new ExportLogsServiceRequest
        {
            ResourceLogs =
            {
                new ResourceLogs
                {
                    Resource = resource,
                    ScopeLogs =
                    {
                        new ScopeLogs
                        {
                            Scope = new InstrumentationScope { Name = "Wolflog.Crash" },
                            LogRecords = { record },
                        },
                    },
                },
            },
        };
    }

    private static KeyValue Kv(string key, string value) => new() { Key = key, Value = new AnyValue { StringValue = value } };

    private static ulong ToUnixNanos(DateTime t) =>
        (ulong)(DateTime.SpecifyKind(t, DateTimeKind.Utc) - DateTime.UnixEpoch).Ticks * 100UL;
}
