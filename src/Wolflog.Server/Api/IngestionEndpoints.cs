namespace Wolflog.Server.Api;

/// <summary>Réception OTLP : HTTP (protobuf ou JSON) et gRPC. La clé API est vérifiée par <see cref="IngestKeyMiddleware"/>.</summary>
public static class IngestionEndpoints
{
    extension(WebApplication app)
    {
        public void MapOtlpIngestion()
        {
            var ingestor = app.Services.GetRequiredService<Ingestor>();
            app.MapPost("/v1/logs", (Func<HttpContext, Task<IResult>>)ingestor.HandleLogs).AllowAnonymous();
            app.MapPost("/v1/traces", (Func<HttpContext, Task<IResult>>)ingestor.HandleTraces).AllowAnonymous();
            app.MapPost("/v1/metrics", (Func<HttpContext, Task<IResult>>)ingestor.HandleMetrics).AllowAnonymous();
            app.MapGrpcService<LogsGrpcService>().AllowAnonymous();
            app.MapGrpcService<TraceGrpcService>().AllowAnonymous();
            app.MapGrpcService<MetricsGrpcService>().AllowAnonymous();
        }
    }
}
