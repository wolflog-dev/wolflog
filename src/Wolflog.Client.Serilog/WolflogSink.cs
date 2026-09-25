using System.Collections;
using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MelLogger = Microsoft.Extensions.Logging.ILogger;
using OpenTelemetry.Logs;
using Serilog.Configuration;
using Serilog.Core;
using Serilog.Events;
using Wolflog.Client.Internal;

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

/// <summary>Transmet les événements Serilog au fournisseur de logs OpenTelemetry de Wolflog.</summary>
internal sealed class WolflogSink : ILogEventSink, IDisposable
{
    private const int MaxPending = 10_000;
    private readonly ConcurrentDictionary<string, MelLogger> _loggers = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<LogEvent> _pending = new();
    private IServiceProvider? _services;
    private ILoggerProvider? _provider;
    private bool _resolved;

    public WolflogSink(IServiceProvider? services)
    {
        _services = services;
        if (_services is null) WolflogRuntime.Started += OnStarted;
    }

    private void OnStarted(IServiceProvider services)
    {
        _services = services;
        _resolved = false;
        while (_pending.TryDequeue(out var e)) Forward(e);
    }

    private ILoggerProvider? Provider
    {
        get
        {
            if (_resolved) return _provider;
            _services ??= WolflogRuntime.Services;
            if (_services is null) return null;
            _provider = _services.GetServices<ILoggerProvider>().OfType<OpenTelemetryLoggerProvider>().FirstOrDefault();
            _resolved = true;
            return _provider;
        }
    }

    public void Emit(LogEvent logEvent)
    {
        if (Provider is null)
        {
            // Hôte pas encore démarré : on garde les événements (démarrage de l'application, erreurs de configuration…).
            if (!_resolved && _pending.Count < MaxPending) _pending.Enqueue(logEvent);
            return;
        }
        Forward(logEvent);
    }

    private void Forward(LogEvent e)
    {
        var provider = Provider;
        if (provider is null) return;

        var category = e.Properties.TryGetValue("SourceContext", out var sc) && sc is ScalarValue { Value: string s } ? s : "Serilog";
        var logger = _loggers.GetOrAdd(category, provider.CreateLogger);
        var level = e.Level switch
        {
            LogEventLevel.Verbose => LogLevel.Trace,
            LogEventLevel.Debug => LogLevel.Debug,
            LogEventLevel.Information => LogLevel.Information,
            LogEventLevel.Warning => LogLevel.Warning,
            LogEventLevel.Error => LogLevel.Error,
            _ => LogLevel.Critical,
        };
        var eventId = e.Properties.TryGetValue("EventId", out var ev) && ev is StructureValue sv
            && sv.Properties.FirstOrDefault(p => p.Name == "Id")?.Value is ScalarValue { Value: int id }
            ? new EventId(id)
            : default;

        logger.Log(level, eventId, new State(e), e.Exception, static (state, _) => Render(state.Event));
    }

    /// <summary>Message rendu sans guillemets autour des chaînes (comme {Value:l}), plus lisible dans Wolflog.</summary>
    internal static string Render(LogEvent e)
    {
        using var writer = new StringWriter(System.Globalization.CultureInfo.InvariantCulture);
        foreach (var token in e.MessageTemplate.Tokens)
        {
            if (token is Serilog.Parsing.PropertyToken { Format: null } p
                && e.Properties.TryGetValue(p.PropertyName, out var value) && value is ScalarValue { Value: string text })
                writer.Write(text);
            else
                token.Render(e.Properties, writer);
        }
        return writer.ToString();
    }

    public void Dispose() => WolflogRuntime.Started -= OnStarted;

    /// <summary>Propriétés Serilog exposées comme attributs (+ modèle du message pour le regroupement).</summary>
    private sealed class State(LogEvent e) : IReadOnlyList<KeyValuePair<string, object?>>
    {
        public LogEvent Event => e;

        private List<KeyValuePair<string, object?>> Items => field ??= Build();

        private List<KeyValuePair<string, object?>> Build()
        {
            var list = new List<KeyValuePair<string, object?>>(e.Properties.Count + 1);
            foreach (var (key, value) in e.Properties)
            {
                if (key is "SourceContext" or "EventId") continue;
                list.Add(new(key, Convert(value)));
            }
            list.Add(new("{OriginalFormat}", e.MessageTemplate.Text));
            return list;
        }

        private static object? Convert(LogEventPropertyValue value) => value switch
        {
            ScalarValue scalar => scalar.Value,
            SequenceValue seq => seq.Elements.Select(Convert).ToArray(),
            _ => value.ToString(),
        };

        public KeyValuePair<string, object?> this[int index] => Items[index];
        public int Count => Items.Count;
        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => Items.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        public override string ToString() => Render(e);
    }
}
