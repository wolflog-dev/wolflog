using Grpc.Core;
using OpenTelemetry.Proto.Collector.Metrics.V1;

namespace Wolflog.Server.Ingestion;

public sealed class MetricsGrpcService(Ingestor ingestor) : MetricsService.MetricsServiceBase
{
    public override async Task<ExportMetricsServiceResponse> Export(ExportMetricsServiceRequest request, ServerCallContext context)
    {
        await ingestor.IngestMetrics(request, default, context.CancellationToken);
        return new ExportMetricsServiceResponse();
    }
}
