using Grpc.Core;
using OpenTelemetry.Proto.Collector.Logs.V1;

namespace Wolflog.Server.Ingestion;

// ---------------------------------------------------------------------- OTLP/gRPC

public sealed class LogsGrpcService(Ingestor ingestor) : LogsService.LogsServiceBase
{
    public override async Task<ExportLogsServiceResponse> Export(ExportLogsServiceRequest request, ServerCallContext context)
    {
        await ingestor.IngestLogs(request, default, context.CancellationToken);
        return new ExportLogsServiceResponse();
    }
}
