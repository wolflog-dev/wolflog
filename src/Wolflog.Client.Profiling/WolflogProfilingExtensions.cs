using Microsoft.Extensions.DependencyInjection;
using Wolflog.Client.Profiling;

// Espace de noms de l'hôte : AddWolflogProfiling() est proposé sans using supplémentaire.
namespace Microsoft.Extensions.Hosting;

/// <summary>Profilage à la demande depuis l'interface de Wolflog.</summary>
public static class WolflogProfilingExtensions
{
    extension(IHostApplicationBuilder builder)
    {
        /// <summary>
        /// Active le profilage à la demande (CPU, allocations) depuis Wolflog. À appeler après <c>AddWolflog()</c>.
        /// </summary>
        public IHostApplicationBuilder AddWolflogProfiling()
        {
            builder.Services.AddWolflogProfiling();
            return builder;
        }
    }

    extension(IServiceCollection services)
    {
        /// <summary>Active le profilage à la demande depuis Wolflog. À appeler après <c>AddWolflog()</c>.</summary>
        public IServiceCollection AddWolflogProfiling()
        {
            services.AddHostedService<ProfilingAgent>();
            return services;
        }
    }
}
