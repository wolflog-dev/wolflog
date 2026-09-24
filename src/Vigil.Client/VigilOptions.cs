using Microsoft.Extensions.Logging;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Vigil.Client;

/// <summary>
/// Configuration du client Vigil. Se lit automatiquement depuis la section "Vigil" de la configuration :
/// <code>
/// "Vigil": { "Endpoint": "https://vigil.mondomaine.fr", "ApiKey": "..." }
/// </code>
/// </summary>
public sealed class VigilOptions
{
    /// <summary>Nom de la section de configuration.</summary>
    public const string Section = "Vigil";

    /// <summary>Active ou désactive complètement l'envoi (ex: false en développement).</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Adresse du serveur Vigil, ex: http://vigil:5080. Obligatoire.</summary>
    public string? Endpoint { get; set; }

    /// <summary>Clé API d'ingestion (commande 'vigil credentials' sur le serveur).</summary>
    public string? ApiKey { get; set; }

    /// <summary>Nom du service. Par défaut : nom de l'application.</summary>
    public string? ServiceName { get; set; }

    /// <summary>Version du service. Par défaut : version de l'assembly d'entrée.</summary>
    public string? ServiceVersion { get; set; }

    /// <summary>Environnement (Production, Staging…). Par défaut : IHostEnvironment.EnvironmentName.</summary>
    public string? Environment { get; set; }

    /// <summary>Envoi des logs ILogger (et Serilog via Vigil.Client.Serilog).</summary>
    public bool Logs { get; set; } = true;

    /// <summary>Envoi des traces (requêtes HTTP entrantes/sortantes, ActivitySource).</summary>
    public bool Traces { get; set; } = true;

    /// <summary>Envoi des métriques (ASP.NET Core, HttpClient, runtime .NET, Meter).</summary>
    public bool Metrics { get; set; } = true;

    /// <summary>Capture des crashs (exceptions non gérées, arrêts brutaux du processus).</summary>
    public bool Crashes { get; set; } = true;

    /// <summary>Capture des en-têtes et corps HTTP (requêtes reçues et appels HttpClient).</summary>
    public HttpCaptureOptions Http { get; set; } = new();

    /// <summary>Proportion de traces conservées (1 = toutes, 0.1 = 10 %).</summary>
    public double TraceSampleRatio { get; set; } = 1.0;

    /// <summary>Niveau minimum envoyé à Vigil. null = règles "Logging:LogLevel" habituelles.</summary>
    public LogLevel? MinimumLevel { get; set; }

    /// <summary>Délai maximum avant envoi d'un lot de logs / traces.</summary>
    public TimeSpan ExportInterval { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>Intervalle d'envoi des métriques.</summary>
    public TimeSpan MetricsInterval { get; set; } = TimeSpan.FromSeconds(15);

    /// <summary>Délai maximum d'une requête vers le serveur avant mise en tampon disque.</summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>Dossier du tampon disque (serveur injoignable, crashs). Par défaut : dossier temporaire/vigil/&lt;service&gt;.</summary>
    public string? BufferDirectory { get; set; }

    /// <summary>Taille maximale du tampon disque (Mo). Au-delà, les plus anciennes données sont supprimées.</summary>
    public int MaxBufferSizeMb { get; set; } = 200;

    /// <summary>ActivitySource supplémentaires à tracer (en plus de ASP.NET Core et HttpClient). "*" = toutes.</summary>
    public List<string> ActivitySources { get; set; } = ["*"];

    /// <summary>Meters supplémentaires à collecter (vos métriques métier).</summary>
    public List<string> Meters { get; set; } = [];

    /// <summary>Chemins HTTP entrants ignorés par les traces (sondes de santé…).</summary>
    public List<string> IgnoredPaths { get; set; } = ["/health", "/healthz", "/ready", "/alive", "/favicon.ico"];

    /// <summary>Attributs ajoutés à toutes les données (ex: "region" = "eu-west").</summary>
    public Dictionary<string, string> ResourceAttributes { get; set; } = [];

    /// <summary>Personnalisation avancée des traces (ex: AddEntityFrameworkCoreInstrumentation()).</summary>
    public Action<TracerProviderBuilder>? ConfigureTracing { get; set; }

    /// <summary>Personnalisation avancée des métriques.</summary>
    public Action<MeterProviderBuilder>? ConfigureMetrics { get; set; }

    /// <summary>Personnalisation avancée de la ressource OpenTelemetry.</summary>
    public Action<ResourceBuilder>? ConfigureResource { get; set; }

    /// <summary>Gestionnaire HTTP personnalisé (proxy, certificats, tests).</summary>
    public Func<HttpMessageHandler>? HttpMessageHandlerFactory { get; set; }
}
