using Serilog.Configuration;
using Serilog.Events;

namespace Serilog;

/// <summary>Intégration Serilog : <c>.WriteTo.Wolflog()</c>.</summary>
public static class WolflogSerilogExtensions
{
    extension(LoggerSinkConfiguration sinkConfiguration)
    {
        /// <summary>
        /// Envoie les événements Serilog vers Wolflog (via le pipeline configuré par <c>AddWolflog()</c>).
        /// Les événements émis avant le démarrage de l'hôte sont conservés (jusqu'à 10 000) puis envoyés.
        /// </summary>
        public LoggerConfiguration Wolflog(IServiceProvider? services = null, LogEventLevel restrictedToMinimumLevel = LevelAlias.Minimum) =>
            sinkConfiguration.Sink(new WolflogSink(services), restrictedToMinimumLevel);
    }
}
