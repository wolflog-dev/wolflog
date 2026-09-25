using Google.Protobuf;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Collector.Trace.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Resource.V1;
using OpenTelemetry.Proto.Trace.V1;
using Wolflog.Server;
using Wolflog.Server.Hosting;
using Wolflog.Server.Storage;

namespace Wolflog.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "wolflog-tests", Guid.NewGuid().ToString("N"));

    public TempDir() => Directory.CreateDirectory(Path);

    public void Dispose()
    {
        for (var i = 0; i < 5; i++)
        {
            try { Directory.Delete(Path, true); return; }
            catch (IOException) { Thread.Sleep(200); }
            catch (UnauthorizedAccessException) { Thread.Sleep(200); }
        }
    }
}

internal sealed class TestEnv(string root) : Microsoft.Extensions.Hosting.IHostEnvironment
{
    public string EnvironmentName { get; set; } = "Test";
    public string ApplicationName { get; set; } = "Wolflog.Tests";
    public string ContentRootPath { get; set; } = root;
    public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
}

internal static class Otlp
{
    public static StorageHost CreateStorage(string dataDir, Action<WolflogServerOptions>? configure = null)
    {
        var options = new WolflogServerOptions { DataDirectory = dataDir };
        options.Storage.FlushIntervalSeconds = 3600; // flush manuel dans les tests
        configure?.Invoke(options);
        var env = new TestEnv(dataDir);
        var opts = Options.Create(options);
        var dataLock = new DataDirectoryLock(opts, env, NullLogger<DataDirectoryLock>.Instance);
        var host = new StorageHost(opts, env, NullLoggerFactory.Instance, dataLock);
        host.StartAsync(default).GetAwaiter().GetResult();
        return host;
    }

    public static Resource Resource(string service, string host = "test-host") => new()
    {
        Attributes =
        {
            Kv("service.name", service),
            Kv("host.name", host),
            Kv("deployment.environment.name", "test"),
        },
    };

    public static KeyValue Kv(string key, string value) => new() { Key = key, Value = new AnyValue { StringValue = value } };

    public static ulong Nanos(DateTime t) => (ulong)(t - DateTime.UnixEpoch).Ticks * 100;

    public static ExportLogsServiceRequest Logs(string service, int count, DateTime? start = null, Func<int, LogRecord>? make = null)
    {
        var t0 = start ?? DateTime.UtcNow;
        var scope = new ScopeLogs { Scope = new InstrumentationScope { Name = "Tests.Category" } };
        for (var i = 0; i < count; i++)
        {
            var r = make?.Invoke(i) ?? new LogRecord
            {
                SeverityNumber = i % 10 == 0 ? SeverityNumber.Error : SeverityNumber.Info,
                Body = new AnyValue { StringValue = $"Message numéro {i} commande-{i % 7}" },
                Attributes = { Kv("http.route", i % 2 == 0 ? "/orders/{id}" : "/stock/{id}") },
            };
            if (r.TimeUnixNano == 0) r.TimeUnixNano = Nanos(t0.AddMilliseconds(i));
            scope.LogRecords.Add(r);
        }
        return new ExportLogsServiceRequest { ResourceLogs = { new ResourceLogs { Resource = Resource(service), ScopeLogs = { scope } } } };
    }

    public static ExportTraceServiceRequest Trace(string service, string traceIdHex, DateTime start, int spans, bool error = false)
    {
        var scope = new ScopeSpans { Scope = new InstrumentationScope { Name = "Tests" } };
        var traceId = ByteString.CopyFrom(Convert.FromHexString(traceIdHex));
        ByteString? parent = null;
        for (var i = 0; i < spans; i++)
        {
            var spanId = ByteString.CopyFrom(BitConverter.GetBytes((long)(i + 1)));
            var s = new Span
            {
                TraceId = traceId,
                SpanId = spanId,
                Name = i == 0 ? "GET /orders/{id}" : $"step {i}",
                Kind = i == 0 ? Span.Types.SpanKind.Server : Span.Types.SpanKind.Internal,
                StartTimeUnixNano = Nanos(start.AddMilliseconds(i)),
                EndTimeUnixNano = Nanos(start.AddMilliseconds(i + 10 * (spans - i))),
                Status = new Status { Code = error && i == spans - 1 ? Status.Types.StatusCode.Error : Status.Types.StatusCode.Unset },
            };
            if (parent != null) s.ParentSpanId = parent;
            parent ??= spanId;
            scope.Spans.Add(s);
        }
        return new ExportTraceServiceRequest { ResourceSpans = { new ResourceSpans { Resource = Resource(service), ScopeSpans = { scope } } } };
    }
}
