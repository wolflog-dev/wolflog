using Grpc.Core;
using OpenTelemetry.Proto.Collector.Trace.V1;

namespace Wolflog.Server.Ingestion;

public sealed class TraceGrpcService(Ingestor ingestor) : TraceService.TraceServiceBase
{
    public override async Task<ExportTraceServiceResponse> Export(ExportTraceServiceRequest request, ServerCallContext context)
    {
        await ingestor.IngestSpans(request, default, context.CancellationToken);
        return new ExportTraceServiceResponse();
    }
}
