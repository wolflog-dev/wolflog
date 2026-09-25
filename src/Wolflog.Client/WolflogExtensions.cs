using System.Reflection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Wolflog.Client;

// Espace de noms de l'hôte : AddWolflog() est disponible sans "using" supplémentaire.
namespace Microsoft.Extensions.Hosting;

/// <summary>Intégration de Wolflog dans une application .NET.</summary>
public static class WolflogExtensions
{
    // Sources de traces courantes émettant nativement des Activity (en plus d'ASP.NET Core et HttpClient).
    private static readonly string[] DefaultSources =
    [
        "Npgsql", "MySqlConnector", "Microsoft.Data.SqlClient.EventSource", "MongoDB.Driver.Core.Extensions.DiagnosticSources",
        "MassTransit", "Azure.*", "Microsoft.Azure.*", "Hangfire", "Quartz", "Grpc.Net.Client", "Microsoft.EntityFrameworkCore",
    ];

    extension<TBuilder>(TBuilder builder) where TBuilder : IHostApplicationBuilder
    {
        /// <summary>
        /// Envoie les logs, traces, métriques et crashs de l'application vers Wolflog.
        /// La configuration est lue dans la section "Wolflog" (Endpoint, ApiKey…).
        /// </summary>
        public TBuilder AddWolflog(Action<WolflogOptions>? configure = null)
        {
            builder.Services.AddWolflog(builder.Configuration, builder.Environment, configure);
            return builder;
        }
    }

    extension(IServiceCollection services)
    {
        /// <summary>Variante pour IHostBuilder / Startup : services.AddWolflog(configuration, environment).</summary>
        public IServiceCollection AddWolflog(IConfiguration configuration, IHostEnvironment? environment = null, Action<WolflogOptions>? configure = null)
        {
            if (services.Any(d => d.ServiceType == typeof(WolflogTransport))) return services; // déjà configuré

            var options = new WolflogOptions();
            configuration.GetSection(WolflogOptions.Section).Bind(options);
            configure?.Invoke(options);

            if (!options.Enabled) return services;
            if (string.IsNullOrWhiteSpace(options.Endpoint))
            {
                Trace.TraceWarning("Wolflog : aucun Endpoint configuré (section \"Wolflog\"), rien ne sera envoyé.");
                return services;
            }

            var entry = Assembly.GetEntryAssembly();
            var identity = new ServiceIdentity(
                Name: options.ServiceName ?? environment?.ApplicationName ?? entry?.GetName().Name ?? "application",
                Version: options.ServiceVersion ?? EntryVersion(entry),
                Environment: options.Environment ?? environment?.EnvironmentName ?? "Production",
                Host: System.Environment.MachineName,
                InstanceId: Guid.NewGuid().ToString("N")[..16],
                Extra: options.ResourceAttributes);

            var bufferDirectory = options.BufferDirectory
                ?? Path.Combine(Path.GetTempPath(), "wolflog", string.Concat(identity.Name.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_')));

            var transport = new WolflogTransport(options, bufferDirectory);
            var breadcrumbs = new Breadcrumbs();
            services.AddSingleton(transport);
            services.AddSingleton(identity);
            services.AddSingleton(options);
            if (options.Crashes)
                services.AddSingleton(new CrashReporter(identity, transport, breadcrumbs, bufferDirectory));
            services.AddHostedService<WolflogLifecycleService>();

            void Exporter(OtlpExporterOptions o, string signal)
            {
                o.Protocol = OtlpExportProtocol.HttpProtobuf;
                o.Endpoint = transport.SignalUri(signal);
                o.HttpClientFactory = transport.CreateExporterClient;
                o.TimeoutMilliseconds = (int)Math.Max(options.Timeout.TotalMilliseconds * 3, 10_000);
            }

            var delayMs = (int)Math.Clamp(options.ExportInterval.TotalMilliseconds, 100, 60_000);
            var appPrefix = entry?.GetName().Name is { } n ? n.Split('.')[0] + "*" : null;

            var otel = services.AddOpenTelemetry().ConfigureResource(r =>
            {
                r.AddService(identity.Name, serviceVersion: identity.Version, serviceInstanceId: identity.InstanceId);
                r.AddAttributes(identity.Attributes());
                options.ConfigureResource?.Invoke(r);
            });

            if (options.Logs || options.Crashes)
            {
                otel.WithLogging(logging =>
                {
                    logging.AddProcessor(breadcrumbs);
                    if (options.Logs)
                    {
                        logging.AddOtlpExporter((exporter, processor) =>
                        {
                            Exporter(exporter, "logs");
                            processor.ExportProcessorType = ExportProcessorType.Batch;
                            processor.BatchExportProcessorOptions.ScheduledDelayMilliseconds = delayMs;
                            processor.BatchExportProcessorOptions.MaxQueueSize = 8192;
                        });
                    }
                }, o =>
                {
                    o.IncludeFormattedMessage = true;
                    o.IncludeScopes = true;
                });

                if (options.MinimumLevel is { } level)
                    services.AddLogging(b => b.AddFilter<OpenTelemetryLoggerProvider>(null, level));
            }

            if (options.Traces)
            {
                var capture = new HttpCaptureRules(options.Http);
                services.AddSingleton(capture);
                services.AddTransient<IStartupFilter, HttpCaptureStartupFilter>();

                otel.WithTracing(tracing =>
                {
                    tracing.SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(Math.Clamp(options.TraceSampleRatio, 0, 1))));
                    tracing.AddAspNetCoreInstrumentation(o =>
                    {
                        o.RecordException = true;
                        o.Filter = ctx => !options.IgnoredPaths.Any(p => ctx.Request.Path.StartsWithSegments(p, StringComparison.OrdinalIgnoreCase));
                    });
                    tracing.AddHttpClientInstrumentation(o =>
                    {
                        o.RecordException = true;
                        o.EnrichWithHttpRequestMessage = (a, r) => Safe(() => HttpClientCapture.OnRequest(capture, a, r));
                        o.EnrichWithHttpResponseMessage = (a, r) => Safe(() => HttpClientCapture.OnResponse(capture, a, r));
                        o.EnrichWithException = (a, _) => Safe(() => HttpClientCapture.OnException(capture, a));
                    });
                    tracing.AddSource(DefaultSources);
                    if (appPrefix != null) tracing.AddSource(appPrefix);
                    foreach (var source in options.ActivitySources) tracing.AddSource(source);
                    options.ConfigureTracing?.Invoke(tracing);
                    tracing.AddProcessor(new IgnoredPathsProcessor(options));
                    tracing.AddOtlpExporter(o =>
                    {
                        Exporter(o, "traces");
                        o.BatchExportProcessorOptions.ScheduledDelayMilliseconds = delayMs;
                        o.BatchExportProcessorOptions.MaxQueueSize = 8192;
                    });
                });
            }

            if (options.Metrics)
            {
                otel.WithMetrics(metrics =>
                {
                    // Exemplars : chaque point de métrique garde quelques mesures reliées à leur trace (clic → trace).
                    metrics.SetExemplarFilter(ExemplarFilterType.TraceBased);
                    metrics.AddAspNetCoreInstrumentation();
                    metrics.AddHttpClientInstrumentation();
#if NET9_0_OR_GREATER
                    metrics.AddMeter("System.Runtime");
#else
                    metrics.AddRuntimeInstrumentation();
#endif
                    if (appPrefix != null) metrics.AddMeter(appPrefix);
                    foreach (var meter in options.Meters) metrics.AddMeter(meter);
                    options.ConfigureMetrics?.Invoke(metrics);
                    metrics.AddOtlpExporter((exporter, reader) =>
                    {
                        Exporter(exporter, "metrics");
                        reader.TemporalityPreference = MetricReaderTemporalityPreference.Delta;
                        reader.PeriodicExportingMetricReaderOptions.ExportIntervalMilliseconds = (int)Math.Clamp(options.MetricsInterval.TotalMilliseconds, 1000, 600_000);
                    });
                });
            }

            return services;
        }
    }

    /// <summary>La capture ne doit jamais faire échouer un appel de l'application.</summary>
    private static void Safe(Action action)
    {
        try { action(); }
        catch (Exception ex) { Trace.TraceWarning($"Wolflog : capture HTTP ignorée ({ex.GetType().Name}: {ex.Message})"); }
    }

    private static string EntryVersion(Assembly? entry)
    {
        var v = entry?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                ?? entry?.GetName().Version?.ToString();
        if (v is null) return "0.0.0";
        var plus = v.IndexOf('+');
        return plus > 0 && v.Length - plus > 8 ? v[..(plus + 8)] : v; // version+hash court
    }
}
