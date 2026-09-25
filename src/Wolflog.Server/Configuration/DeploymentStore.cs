namespace Wolflog.Server.Configuration;

/// <summary>
/// Déploiements : détectés automatiquement quand une version jamais vue d'un service envoie des données,
/// ou déclarés par l'intégration continue.
/// </summary>
public sealed class DeploymentStore : JsonCollection<Deployment>
{
    private readonly ConcurrentDictionary<string, byte> _known = new();

    public DeploymentStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
        : base(o.Value.ResolveDataDirectory(env.ContentRootPath), "deployments.json")
    {
        foreach (var d in All()) _known.TryAdd(Key(d.Service, d.Env, d.Version), 0);
    }

    private static string Key(string service, string? env, string version) => $"{service}\u0001{env}\u0001{version}";

    /// <summary>Appelé à l'ingestion ; très rapide quand la version est déjà connue.</summary>
    public void Observe(string service, string? env, string? version, DateTime at)
    {
        if (string.IsNullOrEmpty(version)) return;
        if (!_known.TryAdd(Key(service, env, version), 0)) return;
        var first = !All().Any(d => d.Service == service && d.Env == env);
        Upsert(new Deployment { Service = service, Env = env, Version = version, At = at, Source = first ? "initial" : "auto" });
    }

    public Deployment Declare(string service, string? env, string version, string? description, string? by, DateTime? at)
    {
        _known.TryAdd(Key(service, env, version), 0);
        var existing = Find(d => d.Service == service && d.Env == env && d.Version == version);
        var deployment = existing ?? new Deployment { Service = service, Env = env, Version = version };
        deployment.At = at ?? DateTime.UtcNow;
        deployment.Source = "api";
        deployment.Description = description ?? deployment.Description;
        deployment.By = by ?? deployment.By;
        return Upsert(deployment);
    }
}
