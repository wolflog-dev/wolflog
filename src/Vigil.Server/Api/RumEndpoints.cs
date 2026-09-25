using System.Security.Cryptography;
using System.Text.Json;
using Google.Protobuf;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Metrics.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Metrics.V1;
using OpenTelemetry.Proto.Resource.V1;
using OpenTelemetry.Proto.Trace.V1;
using Vigil.Server.Ingestion;
using Vigil.Server.Security;

namespace Vigil.Server.Api;

/// <summary>
/// Supervision côté navigateur (RUM) : script /vigil-rum.js et réception /v1/rum.
/// Clé « navigateur » publique, limitée aux sites autorisés (en-tête Origin).
/// </summary>
public static class RumEndpoints
{
    public sealed class RumEvent
    {
        public string Type { get; set; } = "";
        public long Ts { get; set; }
        public string? Path { get; set; }
        // erreur
        public string? Name { get; set; }
        public string? Message { get; set; }
        public string? Stack { get; set; }
        public string? Source { get; set; }
        public int? Line { get; set; }
        public int? Col { get; set; }
        // page
        public double? Duration { get; set; }
        public double? Ttfb { get; set; }
        public double? DomReady { get; set; }
        public long? Size { get; set; }
        public string? Nav { get; set; }
        // réseau
        public string? Method { get; set; }
        public string? Url { get; set; }
        public string? Host { get; set; }
        public int? Status { get; set; }
        public string? Trace { get; set; }
        public string? Span { get; set; }
        // web vital
        public double? Value { get; set; }
    }

    public sealed class RumBatch
    {
        public string? Service { get; set; }
        public string? Env { get; set; }
        public string? Version { get; set; }
        public string? Session { get; set; }
        public string? Ua { get; set; }
        public string? Lang { get; set; }
        public string? Screen { get; set; }
        public List<RumEvent> Events { get; set; } = [];
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly byte[] Script = LoadScript();

    private static byte[] LoadScript()
    {
        using var s = typeof(RumEndpoints).Assembly.GetManifestResourceStream("vigil-rum.js");
        if (s is null) return "/* vigil-rum.js absent de cette version */"u8.ToArray();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    extension(WebApplication app)
    {
        public void MapVigilRum()
        {
            app.MapGet("/vigil-rum.js", (HttpContext ctx) =>
            {
                ctx.Response.Headers.CacheControl = "public, max-age=3600";
                ctx.Response.Headers.AccessControlAllowOrigin = "*";
                return Results.Bytes(Script, "application/javascript; charset=utf-8");
            }).AllowAnonymous();

            app.MapMethods("/v1/rum", ["OPTIONS"], (HttpContext ctx) =>
            {
                Cors(ctx);
                ctx.Response.Headers.AccessControlAllowMethods = "POST";
                ctx.Response.Headers.AccessControlAllowHeaders = "content-type";
                ctx.Response.Headers.AccessControlMaxAge = "86400";
                return Results.NoContent();
            }).AllowAnonymous();

            app.MapPost("/v1/rum", async (HttpContext ctx, AuthService auth, Ingestor ingestor) =>
            {
                Cors(ctx);
                var key = auth.ValidateApiKey(ctx.Request.Query["k"].ToString() is { Length: > 0 } k ? k : AuthService.ReadApiKey(ctx.Request.Headers));
                if (key is null) return Results.Unauthorized();
                var origin = ctx.Request.Headers.Origin.ToString();
                // Clé navigateur : seuls les sites déclarés peuvent l'utiliser (elle est visible dans les pages).
                if (key.Kind == "browser" && key.AllowedOrigins.Count > 0 &&
                    !key.AllowedOrigins.Any(o => string.Equals(o.TrimEnd('/'), origin, StringComparison.OrdinalIgnoreCase)))
                    return Results.StatusCode(StatusCodes.Status403Forbidden);
                if (ctx.Request.ContentLength > 512 * 1024) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

                RumBatch? batch;
                try { batch = await JsonSerializer.DeserializeAsync<RumBatch>(ctx.Request.Body, Json, ctx.RequestAborted); }
                catch (JsonException) { return Results.BadRequest(); }
                if (batch is null || batch.Events.Count == 0) return Results.Accepted();
                if (batch.Events.Count > 500) batch.Events = batch.Events.Take(500).ToList();

                var (logs, spans, metrics) = Convert(batch, origin);
                if (logs.ResourceLogs.Count > 0) await ingestor.IngestLogs(logs, default, ctx.RequestAborted);
                if (spans.ResourceSpans.Count > 0) await ingestor.IngestSpans(spans, default, ctx.RequestAborted);
                if (metrics.ResourceMetrics.Count > 0) await ingestor.IngestMetrics(metrics, default, ctx.RequestAborted);
                return Results.Accepted();
            }).AllowAnonymous();
        }
    }

    private static void Cors(HttpContext ctx)
    {
        var origin = ctx.Request.Headers.Origin.ToString();
        ctx.Response.Headers.AccessControlAllowOrigin = string.IsNullOrEmpty(origin) ? "*" : origin;
        ctx.Response.Headers.Vary = "Origin";
    }

    public static (ExportLogsServiceRequest, ExportTraceServiceRequest, ExportMetricsServiceRequest) Convert(RumBatch b, string? origin)
    {
        var service = string.IsNullOrWhiteSpace(b.Service) ? "navigateur" : b.Service.Trim()[..Math.Min(80, b.Service.Trim().Length)];
        var resource = new Resource { Attributes = { Kv("service.name", service), Kv("telemetry.sdk.name", "vigil-rum") } };
        if (!string.IsNullOrWhiteSpace(b.Env)) resource.Attributes.Add(Kv("deployment.environment.name", b.Env));
        if (!string.IsNullOrWhiteSpace(b.Version)) resource.Attributes.Add(Kv("service.version", b.Version));
        if (!string.IsNullOrWhiteSpace(origin)) resource.Attributes.Add(Kv("browser.origin", origin));

        var common = new List<KeyValue>();
        if (!string.IsNullOrEmpty(b.Session)) common.Add(Kv("session.id", b.Session));
        if (!string.IsNullOrEmpty(b.Ua)) { common.Add(Kv("user_agent.original", b.Ua)); common.Add(Kv("browser.name", BrowserName(b.Ua))); }
        if (!string.IsNullOrEmpty(b.Lang)) common.Add(Kv("browser.language", b.Lang));
        if (!string.IsNullOrEmpty(b.Screen)) common.Add(Kv("browser.screen", b.Screen));

        var scopeLogs = new ScopeLogs { Scope = new InstrumentationScope { Name = "Vigil.Rum" } };
        var scopeSpans = new ScopeSpans { Scope = new InstrumentationScope { Name = "Vigil.Rum" } };
        var scopeMetrics = new ScopeMetrics { Scope = new InstrumentationScope { Name = "Vigil.Rum" } };
        var now = DateTime.UtcNow;

        foreach (var e in b.Events)
        {
            var at = e.Ts > 0 ? DateTime.UnixEpoch.AddMilliseconds(e.Ts) : now;
            if (at > now.AddMinutes(5) || at < now.AddDays(-1)) at = now; // horloge du poste fantaisiste
            var ts = Nanos(at);
            var path = Clip(e.Path, 300) ?? "/";
            switch (e.Type)
            {
                case "error":
                {
                    var name = Clip(e.Name, 100) ?? "Error";
                    var message = Clip(e.Message, 2000) ?? "";
                    var stack = Clip(e.Stack, 16_000);
                    if (!string.IsNullOrEmpty(stack) && !stack.StartsWith(name, StringComparison.Ordinal)) stack = $"{name}: {message}\n{stack}";
                    var record = new LogRecord
                    {
                        TimeUnixNano = ts, SeverityNumber = SeverityNumber.Error, SeverityText = "Error",
                        Body = new AnyValue { StringValue = $"{name}: {message}" },
                        Attributes = { Kv("exception.type", name), Kv("exception.message", message), Kv("url.path", path), Kv("log.category", "navigateur") },
                    };
                    if (!string.IsNullOrEmpty(stack)) record.Attributes.Add(Kv("exception.stacktrace", stack));
                    if (!string.IsNullOrEmpty(e.Source)) record.Attributes.Add(Kv("code.filepath", $"{e.Source}:{e.Line}:{e.Col}"));
                    record.Attributes.AddRange(common);
                    scopeLogs.LogRecords.Add(record);
                    break;
                }
                case "page" or "view":
                {
                    var duration = Math.Clamp(e.Duration ?? 0, 0, 600_000);
                    var span = NewSpan($"page {Ingestion.OtlpConverter.TemplatePath(path)}", Span.Types.SpanKind.Internal, ts, duration, null, null);
                    span.Attributes.Add(Kv("url.path", path));
                    span.Attributes.Add(Kv("browser.navigation", e.Type == "view" ? "route" : e.Nav ?? "navigate"));
                    if (e.Ttfb is { } ttfb) span.Attributes.Add(Num("browser.ttfb_ms", ttfb));
                    if (e.DomReady is { } dom) span.Attributes.Add(Num("browser.dom_ready_ms", dom));
                    if (e.Size is { } size) span.Attributes.Add(Num("browser.transfer_bytes", size));
                    span.Attributes.AddRange(common);
                    scopeSpans.Spans.Add(span);
                    if (e.Type == "page" && duration > 0) scopeMetrics.Metrics.Add(Gauge("browser.page.load", "ms", duration, ts, path));
                    break;
                }
                case "fetch":
                {
                    var method = Clip(e.Method, 10) ?? "GET";
                    var url = Clip(e.Url, 2000) ?? "";
                    var host = Clip(e.Host, 200);
                    var pathOnly = Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.AbsolutePath : url;
                    var span = NewSpan($"{method} {host}{Ingestion.OtlpConverter.TemplatePath(pathOnly)}", Span.Types.SpanKind.Client, ts, e.Duration ?? 0, e.Trace, e.Span);
                    span.Attributes.Add(Kv("http.request.method", method));
                    span.Attributes.Add(Kv("url.full", url));
                    if (host != null) span.Attributes.Add(Kv("server.address", host.Split(':')[0]));
                    span.Attributes.Add(Kv("url.path", path));
                    if (e.Status is > 0) span.Attributes.Add(new KeyValue { Key = "http.response.status_code", Value = new AnyValue { IntValue = e.Status.Value } });
                    if (e.Status is 0 or >= 500) span.Status = new Status { Code = Status.Types.StatusCode.Error, Message = e.Status == 0 ? "Échec réseau" : "" };
                    span.Attributes.AddRange(common);
                    scopeSpans.Spans.Add(span);
                    break;
                }
                case "vital" when e.Value is { } value && e.Name is "lcp" or "fcp" or "inp" or "cls" or "ttfb":
                    scopeMetrics.Metrics.Add(Gauge($"browser.web_vital.{e.Name}", e.Name == "cls" ? "1" : "ms", value, ts, path));
                    break;
            }
        }

        var logs = new ExportLogsServiceRequest();
        var spans = new ExportTraceServiceRequest();
        var metrics = new ExportMetricsServiceRequest();
        if (scopeLogs.LogRecords.Count > 0) logs.ResourceLogs.Add(new ResourceLogs { Resource = resource, ScopeLogs = { scopeLogs } });
        if (scopeSpans.Spans.Count > 0) spans.ResourceSpans.Add(new ResourceSpans { Resource = resource.Clone(), ScopeSpans = { scopeSpans } });
        if (scopeMetrics.Metrics.Count > 0) metrics.ResourceMetrics.Add(new ResourceMetrics { Resource = resource.Clone(), ScopeMetrics = { scopeMetrics } });
        return (logs, spans, metrics);
    }

    private static Span NewSpan(string name, Span.Types.SpanKind kind, ulong start, double durationMs, string? traceHex, string? spanHex)
    {
        var trace = traceHex is { Length: 32 } && traceHex.All(Uri.IsHexDigit) ? System.Convert.FromHexString(traceHex) : RandomNumberGenerator.GetBytes(16);
        var span = spanHex is { Length: 16 } && spanHex.All(Uri.IsHexDigit) ? System.Convert.FromHexString(spanHex) : RandomNumberGenerator.GetBytes(8);
        return new Span
        {
            TraceId = ByteString.CopyFrom(trace), SpanId = ByteString.CopyFrom(span), Name = name, Kind = kind,
            StartTimeUnixNano = start, EndTimeUnixNano = start + (ulong)(Math.Max(0, durationMs) * 1_000_000),
        };
    }

    private static Metric Gauge(string name, string unit, double value, ulong ts, string path)
    {
        var point = new NumberDataPoint { TimeUnixNano = ts, AsDouble = value, Attributes = { Kv("url.path", Ingestion.OtlpConverter.TemplatePath(path)) } };
        return new Metric { Name = name, Unit = unit, Gauge = new Gauge { DataPoints = { point } } };
    }

    private static string BrowserName(string ua) =>
        ua.Contains("Edg/") ? "Edge" : ua.Contains("OPR/") ? "Opera" : ua.Contains("Firefox/") ? "Firefox"
        : ua.Contains("Chrome/") ? "Chrome" : ua.Contains("Safari/") ? "Safari" : "Autre";

    private static string? Clip(string? s, int max) => string.IsNullOrEmpty(s) ? null : s.Length > max ? s[..max] : s;

    private static ulong Nanos(DateTime t) => (ulong)(t - DateTime.UnixEpoch).Ticks * 100;

    private static KeyValue Kv(string key, string value) => new() { Key = key, Value = new AnyValue { StringValue = value } };

    private static KeyValue Num(string key, double value) => new() { Key = key, Value = new AnyValue { DoubleValue = value } };
}
