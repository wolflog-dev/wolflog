using System.IO.Compression;
using System.Text.Json.Nodes;
using Google.Protobuf;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Metrics.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;

namespace Wolflog.Server.Ingestion;

/// <summary>Point d'entrée OTLP commun au HTTP et au gRPC.</summary>
public sealed class Ingestor(StorageHost storage, Configuration.DeploymentStore deployments, IOptions<WolflogServerOptions> options, ILogger<Ingestor> log)
{
    private static readonly JsonParser OtlpJson = new(JsonParser.Settings.Default.WithIgnoreUnknownFields(true));

    public async Task IngestLogs(ExportLogsServiceRequest request, ReadOnlyMemory<byte> raw, CancellationToken ct)
    {
        var rows = OtlpConverter.ConvertLogs(request);
        ObserveVersions(rows, static r => (r.Service, r.Env, r.Version, r.Ts));
        await storage.Logs.IngestAsync(rows, raw.IsEmpty ? request.ToByteArray() : raw, ct);
    }

    public async Task IngestSpans(ExportTraceServiceRequest request, ReadOnlyMemory<byte> raw, CancellationToken ct)
    {
        var rows = OtlpConverter.ConvertSpans(request);
        ObserveVersions(rows, static r => (r.Service, r.Env, r.Version, r.Ts));
        await storage.Spans.IngestAsync(rows, raw.IsEmpty ? request.ToByteArray() : raw, ct);
    }

    public async Task IngestMetrics(ExportMetricsServiceRequest request, ReadOnlyMemory<byte> raw, CancellationToken ct)
    {
        var rows = OtlpConverter.ConvertMetrics(request);
        await storage.Metrics.IngestAsync(rows, raw.IsEmpty ? request.ToByteArray() : raw, ct);
    }

    /// <summary>Détection des déploiements : une version jamais vue d'un service devient un marqueur.</summary>
    private void ObserveVersions<TRow>(List<TRow> rows, Func<TRow, (string Service, string? Env, string? Version, DateTime Ts)> key)
    {
        string? lastService = null, lastEnv = null, lastVersion = null;
        foreach (var row in rows)
        {
            var (service, env, version, ts) = key(row);
            if (version is null || (service == lastService && env == lastEnv && version == lastVersion)) continue;
            (lastService, lastEnv, lastVersion) = (service, env, version);
            try { deployments.Observe(service, env, version, ts); }
            catch (Exception ex) { log.LogWarning(ex, "Enregistrement du déploiement impossible"); }
        }
    }

    // ------------------------------------------------------------------ OTLP/HTTP

    public Task<IResult> HandleLogs(HttpContext ctx) =>
        Handle(ctx, ExportLogsServiceRequest.Parser, (r, raw, ct) => IngestLogs(r, raw, ct), new ExportLogsServiceResponse());

    public Task<IResult> HandleTraces(HttpContext ctx) =>
        Handle(ctx, ExportTraceServiceRequest.Parser, (r, raw, ct) => IngestSpans(r, raw, ct), new ExportTraceServiceResponse());

    public Task<IResult> HandleMetrics(HttpContext ctx) =>
        Handle(ctx, ExportMetricsServiceRequest.Parser, (r, raw, ct) => IngestMetrics(r, raw, ct), new ExportMetricsServiceResponse());

    private async Task<IResult> Handle<T>(HttpContext ctx, MessageParser<T> parser, Func<T, ReadOnlyMemory<byte>, CancellationToken, Task> ingest, IMessage response)
        where T : IMessage<T>, new()
    {
        var contentType = ctx.Request.ContentType ?? "application/x-protobuf";
        var isJson = contentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase);

        byte[] body;
        try
        {
            body = await ReadBody(ctx.Request, MaxDecompressedBytes, ctx.RequestAborted);
        }
        catch (PayloadTooLargeException ex)
        {
            log.LogWarning("Envoi OTLP refusé : {Message}", ex.Message);
            return Results.Problem(ex.Message, statusCode: StatusCodes.Status413PayloadTooLarge);
        }
        catch (InvalidDataException)
        {
            return Results.BadRequest("Corps compressé invalide.");
        }
        catch (NotSupportedException ex)
        {
            return Results.Problem(ex.Message, statusCode: StatusCodes.Status415UnsupportedMediaType);
        }

        T request;
        try
        {
            if (isJson)
            {
                request = OtlpJson.Parse<T>(FixJsonIds(body));
                body = request.ToByteArray();
            }
            else
            {
                request = parser.ParseFrom(body);
            }
        }
        catch (Exception ex) when (ex is InvalidProtocolBufferException or InvalidJsonException or System.Text.Json.JsonException or FormatException)
        {
            log.LogDebug(ex, "Requête OTLP invalide");
            return Results.BadRequest("Message OTLP invalide.");
        }

        await ingest(request, body, ctx.RequestAborted);

        return isJson
            ? Results.Text("{}", "application/json")
            : Results.Bytes(response.ToByteArray(), "application/x-protobuf");
    }

    /// <summary>Plafond d'un envoi une fois décompressé (Wolflog:Ingestion:MaxDecompressedMb).</summary>
    public long MaxDecompressedBytes => Math.Max(1, options.Value.Ingestion.MaxDecompressedMb) * 1024L * 1024;

    /// <summary>
    /// Corps de la requête, décompressé (gzip, deflate) et plafonné : un petit envoi compressé qui donnerait des Go une
    /// fois décompressé est refusé dès le dépassement, sans saturer la mémoire. Brotli n'est pas accepté : OTLP n'exige
    /// que gzip, et décoder du brotli reçu exposait au défaut du décodeur CVE-2026-111497 (« Node2Shell »).
    /// </summary>
    public static Stream OpenBody(HttpRequest request, long maxBytes)
    {
        Stream stream = request.Body;
        var encoding = request.Headers.ContentEncoding.ToString().Trim();
        if (encoding.Equals("gzip", StringComparison.OrdinalIgnoreCase)) stream = new GZipStream(stream, CompressionMode.Decompress);
        else if (encoding.Equals("deflate", StringComparison.OrdinalIgnoreCase)) stream = new ZLibStream(stream, CompressionMode.Decompress);
        else if (encoding.Length > 0 && !encoding.Equals("identity", StringComparison.OrdinalIgnoreCase))
            throw new NotSupportedException($"Content-Encoding « {encoding} » non pris en charge (gzip ou deflate).");
        return new SizeLimitedStream(stream, maxBytes);
    }

    private static async Task<byte[]> ReadBody(HttpRequest request, long maxBytes, CancellationToken ct)
    {
        await using var stream = OpenBody(request, maxBytes);
        // Capacité initiale d'après la taille annoncée, jamais au-delà du plafond (la taille annoncée n'est pas fiable).
        var capacity = (int)Math.Min(request.ContentLength is > 0 ? request.ContentLength.Value : 16 * 1024, Math.Min(maxBytes, 16 * 1024 * 1024));
        using var ms = new MemoryStream(capacity);
        await stream.CopyToAsync(ms, ct);
        return ms.ToArray();
    }

    /// <summary>
    /// En OTLP/JSON les identifiants sont en hexadécimal, alors que le mapping JSON protobuf standard attend du base64.
    /// </summary>
    private static string FixJsonIds(byte[] json)
    {
        var node = JsonNode.Parse(json);
        Walk(node);
        return node?.ToJsonString() ?? "{}";

        static void Walk(JsonNode? n)
        {
            switch (n)
            {
                case JsonObject obj:
                    foreach (var (key, value) in obj.ToList())
                    {
                        if (key is "traceId" or "spanId" or "parentSpanId" && value is JsonValue v && v.TryGetValue<string>(out var s)
                            && s.Length is 16 or 32 && s.All(Uri.IsHexDigit))
                        {
                            obj[key] = Convert.ToBase64String(Convert.FromHexString(s));
                        }
                        else
                        {
                            Walk(value);
                        }
                    }
                    break;
                case JsonArray arr:
                    foreach (var item in arr) Walk(item);
                    break;
            }
        }
    }
}
