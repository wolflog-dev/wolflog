using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace Wolflog.Server.Configuration;

// ---------------------------------------------------------------------- statut des erreurs

public sealed class ErrorHistoryEntry
{
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string? By { get; set; }
    public string Action { get; set; } = "";
}

/// <summary>Suivi d'un groupe d'erreurs (clé = empreinte).</summary>
public sealed class ErrorState : IEntity
{
    public string Id { get; set; } = "";
    /// <summary>open, resolved ou ignored. "regressed" est calculé : résolue puis revue ensuite.</summary>
    public string Status { get; set; } = "open";
    public DateTime? ResolvedAt { get; set; }
    public string? AssignedTo { get; set; }
    public string? Note { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<ErrorHistoryEntry> History { get; set; } = [];
}

public static class ErrorStatus
{
    public const string Open = "open";
    public const string Resolved = "resolved";
    public const string Ignored = "ignored";
    public const string Regressed = "regressed";

    /// <summary>Statut affiché : une erreur résolue qui se reproduit après sa résolution est "réapparue".</summary>
    public static string Effective(ErrorState? state, DateTime lastSeen) => state?.Status switch
    {
        Resolved when state.ResolvedAt is { } at && lastSeen > at => Regressed,
        Resolved => Resolved,
        Ignored => Ignored,
        _ => Open,
    };
}

public sealed class ErrorStateStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<ErrorState>(o.Value.ResolveDataDirectory(env.ContentRootPath), "error-states.json")
{
    public Dictionary<string, ErrorState> Map() => All().ToDictionary(s => s.Id);

    public ErrorState Apply(string fingerprint, string? status, string? assignedTo, string? note, bool clearAssignee, string? by)
    {
        var state = Get(fingerprint) ?? new ErrorState { Id = fingerprint };
        void Log(string action) => state.History.Insert(0, new ErrorHistoryEntry { By = by, Action = action });
        if (status is ErrorStatus.Open or ErrorStatus.Resolved or ErrorStatus.Ignored && status != state.Status)
        {
            state.Status = status;
            state.ResolvedAt = status == ErrorStatus.Resolved ? DateTime.UtcNow : null;
            Log(status switch { ErrorStatus.Resolved => "a résolu l'erreur", ErrorStatus.Ignored => "a ignoré l'erreur", _ => "a rouvert l'erreur" });
        }
        if (clearAssignee && state.AssignedTo != null)
        {
            state.AssignedTo = null;
            Log("a retiré l'assignation");
        }
        else if (!string.IsNullOrWhiteSpace(assignedTo) && assignedTo != state.AssignedTo)
        {
            state.AssignedTo = assignedTo;
            Log($"a assigné l'erreur à {assignedTo}");
        }
        if (note != null && note != state.Note)
        {
            state.Note = note;
            Log("a modifié la note");
        }
        if (state.History.Count > 50) state.History.RemoveRange(50, state.History.Count - 50);
        state.UpdatedAt = DateTime.UtcNow;
        return Upsert(state);
    }
}

// ---------------------------------------------------------------------- déploiements

public sealed class Deployment : IEntity
{
    public string Id { get; set; } = "";
    public string Service { get; set; } = "";
    public string? Env { get; set; }
    public string Version { get; set; } = "";
    public DateTime At { get; set; }
    /// <summary>auto (nouvelle version détectée), initial (première version vue), api (déclaré par la CI).</summary>
    public string Source { get; set; } = "auto";
    public string? Description { get; set; }
    public string? By { get; set; }
}

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

// ---------------------------------------------------------------------- recherches enregistrées

public sealed class SavedSearch : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>logs, requests, traces ou errors.</summary>
    public string Page { get; set; } = "logs";
    public Dictionary<string, string> Params { get; set; } = [];
    public string? Owner { get; set; }
    public bool Shared { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class SavedSearchStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<SavedSearch>(o.Value.ResolveDataDirectory(env.ContentRootPath), "saved-searches.json");
