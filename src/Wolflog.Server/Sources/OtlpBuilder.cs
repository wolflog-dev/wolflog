using System.Security.Cryptography;
using Google.Protobuf;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Resource.V1;
using OpenTelemetry.Proto.Trace.V1;

namespace Wolflog.Server.Sources;

/// <summary>Convertit des entrées lues en messages OTLP (logs, et spans pour les requêtes HTTP des journaux web).</summary>
public static class OtlpBuilder
{
    public static (ExportLogsServiceRequest? Logs, ExportTraceServiceRequest? Spans) Build(
        IReadOnlyCollection<ParsedEntry> entries, string defaultService, string? env, string sourceName)
    {
        ExportLogsServiceRequest? logs = null;
        ExportTraceServiceRequest? spans = null;
        foreach (var group in entries.GroupBy(e => (Service: string.IsNullOrWhiteSpace(e.Service) ? defaultService : e.Service!, e.Host)))
        {
            var resource = new Resource { Attributes = { Kv("service.name", group.Key.Service), Kv("wolflog.source", sourceName) } };
            if (!string.IsNullOrEmpty(group.Key.Host)) resource.Attributes.Add(Kv("host.name", group.Key.Host));
            if (!string.IsNullOrEmpty(env)) resource.Attributes.Add(Kv("deployment.environment.name", env));

            var scopeLogs = new ScopeLogs { Scope = new InstrumentationScope { Name = "Wolflog.Sources" } };
            var scopeSpans = new ScopeSpans { Scope = new InstrumentationScope { Name = "Wolflog.Sources" } };
            foreach (var e in group)
            {
                var ts = Nanos(e.Ts);
                if (e.Http is { } h)
                {
                    scopeSpans.Spans.Add(Span(e, h, ts));
                    if (h.Status < 500) continue; // les requêtes réussies ne sont que des spans
                }
                var record = new LogRecord
                {
                    TimeUnixNano = ts, ObservedTimeUnixNano = Nanos(DateTime.UtcNow), SeverityNumber = (SeverityNumber)Math.Clamp(e.Severity, 1, 24),
                    SeverityText = LevelName(e.Severity), Body = new AnyValue { StringValue = e.Body },
                };
                if (!string.IsNullOrEmpty(e.Category)) record.Attributes.Add(Kv("log.category", e.Category));
                foreach (var (k, v) in e.Attributes) record.Attributes.Add(Kv(k, v));
                scopeLogs.LogRecords.Add(record);
            }
            if (scopeLogs.LogRecords.Count > 0)
                (logs ??= new()).ResourceLogs.Add(new ResourceLogs { Resource = resource, ScopeLogs = { scopeLogs } });
            if (scopeSpans.Spans.Count > 0)
                (spans ??= new()).ResourceSpans.Add(new ResourceSpans { Resource = resource.Clone(), ScopeSpans = { scopeSpans } });
        }
        return (logs, spans);
    }

    private static Span Span(ParsedEntry e, HttpEntry h, ulong end)
    {
        var duration = (ulong)(Math.Max(0, h.DurationMs) * 1_000_000);
        // Pas de route connue dans un journal web : chemin généralisé (/orders/42 → /orders/{id}) pour regrouper.
        var route = Ingestion.OtlpConverter.TemplatePath(h.Path);
        var span = new Span
        {
            TraceId = ByteString.CopyFrom(RandomNumberGenerator.GetBytes(16)),
            SpanId = ByteString.CopyFrom(RandomNumberGenerator.GetBytes(8)),
            Name = $"{h.Method} {route}",
            Kind = OpenTelemetry.Proto.Trace.V1.Span.Types.SpanKind.Server,
            StartTimeUnixNano = end > duration ? end - duration : end,
            EndTimeUnixNano = end,
            Status = new Status { Code = h.Status >= 500 ? Status.Types.StatusCode.Error : Status.Types.StatusCode.Unset },
            Attributes =
            {
                Kv("http.request.method", h.Method), Kv("url.path", h.Path), Kv("http.route", route),
                new KeyValue { Key = "http.response.status_code", Value = new AnyValue { IntValue = h.Status } },
            },
        };
        if (!string.IsNullOrEmpty(h.Query)) span.Attributes.Add(Kv("url.query", h.Query));
        if (!string.IsNullOrEmpty(h.ClientIp)) span.Attributes.Add(Kv("client.address", h.ClientIp));
        if (!string.IsNullOrEmpty(h.UserAgent)) span.Attributes.Add(Kv("user_agent.original", h.UserAgent));
        if (!string.IsNullOrEmpty(h.Host)) span.Attributes.Add(Kv("server.address", h.Host));
        foreach (var (k, v) in e.Attributes) span.Attributes.Add(Kv(k, v));
        return span;
    }

    private static string LevelName(int severity) => severity switch
    {
        <= 4 => "Trace", <= 8 => "Debug", <= 12 => "Information", <= 16 => "Warning", <= 20 => "Error", _ => "Critical",
    };

    private static ulong Nanos(DateTime t) => (ulong)Math.Max(0, (DateTime.SpecifyKind(t, DateTimeKind.Utc) - DateTime.UnixEpoch).Ticks) * 100;

    private static KeyValue Kv(string key, string value) => new() { Key = key, Value = new AnyValue { StringValue = value } };
}
