using System.Diagnostics;
using System.Text.Json;
using Google.Protobuf;
using OpenTelemetry;
using SdkLogRecord = OpenTelemetry.Logs.LogRecord;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Resource.V1;

namespace Vigil.Client.Internal;

/// <summary>Identité du service, partagée par OpenTelemetry et les rapports de crash.</summary>
internal sealed record ServiceIdentity(
    string Name, string Version, string Environment, string Host, string InstanceId, IReadOnlyDictionary<string, string> Extra)
{
    public IEnumerable<KeyValuePair<string, object>> Attributes()
    {
        yield return new("service.name", Name);
        yield return new("service.version", Version);
        yield return new("service.instance.id", InstanceId);
        yield return new("deployment.environment.name", Environment);
        yield return new("host.name", Host);
        yield return new("process.pid", (long)System.Environment.ProcessId);
        yield return new("process.runtime.name", ".NET");
        yield return new("process.runtime.version", System.Environment.Version.ToString());
        yield return new("os.type", OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsLinux() ? "linux" : OperatingSystem.IsMacOS() ? "darwin" : "other");
        foreach (var kv in Extra) yield return new(kv.Key, kv.Value);
    }
}

/// <summary>Les derniers logs émis, joints aux rapports de crash pour comprendre ce qui s'est passé juste avant.</summary>
internal sealed class Breadcrumbs : BaseProcessor<SdkLogRecord>
{
    public sealed record Crumb(DateTime Ts, string Level, string? Category, string Message);

    private const int Capacity = 40;
    private readonly Crumb?[] _ring = new Crumb?[Capacity];
    private readonly object _lock = new(); // net8 : pas de System.Threading.Lock
    private int _next;
    private long _version;

    public long Version => Interlocked.Read(ref _version);

    public override void OnEnd(SdkLogRecord data)
    {
        var message = data.FormattedMessage ?? data.Body ?? "";
        if (message.Length > 500) message = message[..500] + "…";
        if (data.Exception != null) message += $" [{data.Exception.GetType().Name}: {data.Exception.Message}]";
        var crumb = new Crumb(data.Timestamp, data.LogLevel.ToString(), data.CategoryName, message);
        lock (_lock)
        {
            _ring[_next] = crumb;
            _next = (_next + 1) % Capacity;
        }
        Interlocked.Increment(ref _version);
    }

    public List<Crumb> Snapshot()
    {
        lock (_lock)
        {
            var list = new List<Crumb>(Capacity);
            for (var i = 0; i < Capacity; i++)
            {
                var c = _ring[(_next + i) % Capacity];
                if (c != null) list.Add(c);
            }
            return list;
        }
    }
}

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
        record.Attributes.Add(new KeyValue { Key = "vigil.crash", Value = new AnyValue { BoolValue = true } });
        record.Attributes.Add(Kv("vigil.breadcrumbs", JsonSerializer.Serialize(breadcrumbs)));
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
                            Scope = new InstrumentationScope { Name = "Vigil.Crash" },
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

/// <summary>
/// Capture les exceptions non gérées (écriture disque synchrone : le processus va s'arrêter)
/// et détecte au démarrage suivant les processus morts sans prévenir (StackOverflow, OOM, kill -9…).
/// </summary>
internal sealed class CrashReporter : IDisposable
{
    private readonly ServiceIdentity _identity;
    private readonly VigilTransport _transport;
    private readonly Breadcrumbs _breadcrumbs;
    private readonly string _sessionsDir;
    private readonly string _markerPath;
    private readonly DateTime _processStart;
    private Timer? _timer;
    private long _savedVersion = -1;
    private int _crashed;

    /// <summary>Appelé juste avant l'arrêt du processus (vidage des providers OpenTelemetry).</summary>
    public Action<TimeSpan>? FlushTelemetry { get; set; }

    public CrashReporter(ServiceIdentity identity, VigilTransport transport, Breadcrumbs breadcrumbs, string bufferDirectory)
    {
        _identity = identity;
        _transport = transport;
        _breadcrumbs = breadcrumbs;
        _sessionsDir = Path.Combine(bufferDirectory, "sessions");
        Directory.CreateDirectory(_sessionsDir);
        using var self = Process.GetCurrentProcess();
        _processStart = self.StartTime.ToUniversalTime();
        _markerPath = Path.Combine(_sessionsDir, $"{Environment.ProcessId}-{_processStart.Ticks}.json");
    }

    public void Start()
    {
        ReportAbandonedSessions();
        WriteMarker();
        _timer = new Timer(_ => { if (_breadcrumbs.Version != Interlocked.Read(ref _savedVersion)) WriteMarker(); }, null, 5000, 5000);
        AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
    }

    private sealed record Marker(int Pid, DateTime ProcessStart, DateTime LastSeen, string Version, List<Breadcrumbs.Crumb> Breadcrumbs);

    private void WriteMarker()
    {
        if (Volatile.Read(ref _crashed) == 1) return;
        try
        {
            var version = _breadcrumbs.Version;
            var marker = new Marker(Environment.ProcessId, _processStart, DateTime.UtcNow, _identity.Version, _breadcrumbs.Snapshot());
            var tmp = _markerPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(marker));
            File.Move(tmp, _markerPath, overwrite: true);
            Interlocked.Exchange(ref _savedVersion, version);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Un marqueur dont le processus n'existe plus = arrêt brutal non signalé.</summary>
    private void ReportAbandonedSessions()
    {
        foreach (var file in Directory.GetFiles(_sessionsDir, "*.json"))
        {
            if (string.Equals(file, _markerPath, StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                var marker = JsonSerializer.Deserialize<Marker>(File.ReadAllText(file));
                if (marker is null) { File.Delete(file); continue; }
                if (IsAlive(marker.Pid, marker.ProcessStart)) continue;

                var body = $"Le processus {marker.Pid} (version {marker.Version}, démarré le {marker.ProcessStart:u}) s'est arrêté brutalement, " +
                           "sans exception gérée : StackOverflow, OutOfMemory, crash natif, Environment.FailFast ou arrêt forcé (kill -9, recyclage IIS, timeout du service).";
                var request = CrashReport.Build(_identity, marker.LastSeen, "Vigil.AbnormalTermination",
                    "Arrêt brutal du processus", null, body, marker.Breadcrumbs,
                    [new("process.pid.previous", marker.Pid.ToString()), new("vigil.last_seen", marker.LastSeen.ToString("O"))]);
                _transport.Outbox.Store("logs", VigilTransport.Gzip(request.ToByteArray()));
                File.Delete(file);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                try { File.Delete(file); } catch { /* ignoré */ }
            }
        }
    }

    private static bool IsAlive(int pid, DateTime processStart)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return Math.Abs((p.StartTime.ToUniversalTime() - processStart).TotalSeconds) < 2;
        }
        catch (ArgumentException) { return false; }          // n'existe plus
        catch (InvalidOperationException) { return false; }  // terminé
        catch (System.ComponentModel.Win32Exception) { return true; } // accès refusé : existe
    }

    private void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        if (Interlocked.Exchange(ref _crashed, 1) == 1) return;
        try
        {
            var ex = e.ExceptionObject as Exception;
            var type = ex?.GetType().FullName ?? e.ExceptionObject?.GetType().FullName ?? "UnknownException";
            var message = ex?.Message ?? e.ExceptionObject?.ToString() ?? "";
            var request = CrashReport.Build(_identity, DateTime.UtcNow, type, message, ex?.ToString(),
                $"Exception non gérée : {type}: {message}", _breadcrumbs.Snapshot(),
                [new("vigil.terminating", e.IsTerminating ? "true" : "false")],
                Activity.Current?.Context);

            // 1. Sur disque d'abord (le processus peut s'arrêter à tout moment).
            _transport.Outbox.Store("logs", VigilTransport.Gzip(request.ToByteArray()));
            TryDelete(_markerPath);

            // 2. Puis tentative d'envoi immédiat de tout ce qui est en attente.
            FlushTelemetry?.Invoke(TimeSpan.FromSeconds(2));
            _transport.DrainOutboxBlocking(TimeSpan.FromSeconds(3));
        }
        catch
        {
            // Ne jamais masquer l'exception d'origine.
        }
    }

    private void OnProcessExit(object? sender, EventArgs e) => MarkCleanShutdown();

    /// <summary>Arrêt normal : le marqueur est supprimé, aucun crash ne sera signalé.</summary>
    public void MarkCleanShutdown()
    {
        _timer?.Dispose();
        if (Volatile.Read(ref _crashed) == 0) TryDelete(_markerPath);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* ignoré */ }
    }

    public void Dispose()
    {
        AppDomain.CurrentDomain.UnhandledException -= OnUnhandledException;
        AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
        MarkCleanShutdown();
    }
}
