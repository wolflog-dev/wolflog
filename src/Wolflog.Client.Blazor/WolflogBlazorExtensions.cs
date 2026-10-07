using Microsoft.AspNetCore.Components.Server.Circuits;
using Microsoft.AspNetCore.HttpLogging;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Wolflog.Client.Blazor;

// Espace de noms de l'hôte : AddWolflogBlazor() est disponible sans "using" supplémentaire.
namespace Microsoft.Extensions.Hosting;

/// <summary>Intégration de Wolflog dans une application Blazor Server.</summary>
public static class WolflogBlazorExtensions
{
    internal const string HttpClientName = "Wolflog.Blazor";

    extension<TBuilder>(TBuilder builder) where TBuilder : IHostApplicationBuilder
    {
        /// <summary>
        /// Audience anonyme et santé des circuits Blazor Server, envoyées à Wolflog.
        /// La configuration est lue dans la section "Wolflog" (Endpoint, ApiKey, ServiceName, Environment).
        /// </summary>
        public TBuilder AddWolflogBlazor(Action<WolflogBlazorOptions>? configure = null)
        {
            var section = builder.Configuration.GetSection("Wolflog");
            var environment = builder.Environment;
            builder.Services.AddOptions<WolflogBlazorOptions>()
                .Bind(section)
                .Configure(o =>
                {
                    o.ServiceName ??= environment.ApplicationName;
                    o.Environment ??= environment.EnvironmentName;
                    configure?.Invoke(o);
                });
            builder.Services.AddHttpClient(HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
            builder.Services.AddHttpContextAccessor();
            builder.Services.TryAddSingleton<AnalyticsSender>();
            builder.Services.AddHostedService(sp => sp.GetRequiredService<AnalyticsSender>());
            builder.Services.TryAddScoped<VisitorContext>();
            builder.Services.TryAddScoped<IWolflogTracker, WolflogTracker>();
            builder.Services.TryAddEnumerable(ServiceDescriptor.Scoped<CircuitHandler, AnalyticsCircuitHandler>());
            // Journaux HTTP de l'application : jamais les mesures ni les captures de page qui passent par le relais /_wolflog.
            builder.Services.TryAddEnumerable(ServiceDescriptor.Singleton<IHttpLoggingInterceptor, RelayHttpLogging>());
            return builder;
        }
    }
}
