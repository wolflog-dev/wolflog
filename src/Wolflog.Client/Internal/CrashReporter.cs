using Google.Protobuf;

namespace Wolflog.Client.Internal;

/// <summary>
/// Capture les exceptions non gérées (écriture disque synchrone : le processus va s'arrêter)
/// et détecte au démarrage suivant les processus morts sans prévenir (StackOverflow, OOM, kill -9…).
/// </summary>
internal sealed class CrashReporter : IDisposable
{
    private readonly ServiceIdentity _identity;
    private readonly WolflogTransport _transport;
    private readonly Breadcrumbs _breadcrumbs;
    private readonly string _sessionsDir;
    private readonly string _markerPath;
    private readonly DateTime _processStart;
    private Timer? _timer;
    private long _savedVersion = -1;
    private int _crashed;

    /// <summary>Appelé juste avant l'arrêt du processus (vidage des providers OpenTelemetry).</summary>
    public Action<TimeSpan>? FlushTelemetry { get; set; }

    public CrashReporter(ServiceIdentity identity, WolflogTransport transport, Breadcrumbs breadcrumbs, string bufferDirectory)
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
                var request = CrashReport.Build(_identity, marker.LastSeen, "Wolflog.AbnormalTermination",
                    "Arrêt brutal du processus", null, body, marker.Breadcrumbs,
                    [new("process.pid.previous", marker.Pid.ToString()), new("wolflog.last_seen", marker.LastSeen.ToString("O"))]);
                _transport.Outbox.Store("logs", WolflogTransport.Gzip(request.ToByteArray()));
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
                [new("wolflog.terminating", e.IsTerminating ? "true" : "false")],
                Activity.Current?.Context);

            // 1. Sur disque d'abord (le processus peut s'arrêter à tout moment).
            _transport.Outbox.Store("logs", WolflogTransport.Gzip(request.ToByteArray()));
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
