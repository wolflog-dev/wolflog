using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

namespace Wolflog.Client.Internal;

/// <summary>Accès statique au conteneur (utilisé par le sink Serilog créé avant l'hôte).</summary>
internal static class WolflogRuntime
{
    public static IServiceProvider? Services { get; private set; }
    public static event Action<IServiceProvider>? Started;
    public static void RaiseStarted(IServiceProvider sp)
    {
        Services = sp;
        Started?.Invoke(sp);
    }
}

/// <summary>Démarrage : crashs précédents, renvoi du tampon disque. Arrêt : marque la fin propre de la session.</summary>
internal sealed class WolflogLifecycleService(
    IServiceProvider services,
    WolflogTransport transport,
    ILoggerFactory loggers,
    CrashReporter? crashes = null) : IHostedService
{
    private readonly ILogger _log = loggers.CreateLogger("Wolflog");

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (crashes != null)
        {
            crashes.FlushTelemetry = timeout =>
            {
                var ms = (int)timeout.TotalMilliseconds;
                services.GetService<LoggerProvider>()?.ForceFlush(ms);
                services.GetService<TracerProvider>()?.ForceFlush(ms);
                services.GetService<MeterProvider>()?.ForceFlush(ms);
            };
            crashes.Start();
        }
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
        transport.StartRetryLoop();
        WolflogRuntime.RaiseStarted(services);
        return Task.CompletedTask;
    }

    private void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e) =>
        _log.LogError(e.Exception, "Exception non observée dans une tâche");

    public Task StopAsync(CancellationToken cancellationToken)
    {
        TaskScheduler.UnobservedTaskException -= OnUnobservedTaskException;
        crashes?.MarkCleanShutdown();
        transport.StopRetryLoop();
        return Task.CompletedTask;
    }
}
