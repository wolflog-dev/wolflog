using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Wolflog.Server.Configuration;

namespace Wolflog.Server.Monitoring;

/// <summary>Instance d'application qui peut être profilée (paquet Wolflog.Client.Profiling), vue récemment.</summary>
public sealed record ProfilingInstance(string Service, string Instance, string? Host, string? Version, string? Runtime, DateTime LastSeen);

public sealed record ProfileRequest(string Id, string Service, string Instance, string Kind, int Seconds, DateTime RequestedAt, string? RequestedBy);

public sealed class ProfileInfo : IEntity
{
    public string Id { get; set; } = "";
    public string Service { get; set; } = "";
    public string Instance { get; set; } = "";
    public string? Host { get; set; }
    public string? Version { get; set; }
    /// <summary>cpu ou alloc.</summary>
    public string Kind { get; set; } = "cpu";
    public DateTime Start { get; set; }
    public double Seconds { get; set; }
    public long Samples { get; set; }
    /// <summary>Somme des poids (échantillons ou octets alloués).</summary>
    public long Total { get; set; }
    public string? Error { get; set; }
    /// <summary>pending (demandé, pas encore reçu), done, failed.</summary>
    public string Status { get; set; } = "pending";
    public string? RequestedBy { get; set; }
    public DateTime RequestedAt { get; set; } = DateTime.UtcNow;
}

public sealed record StackWeight(string S, long V);

/// <summary>Profils demandés et reçus : index en JSON, piles dans profiles/{id}.json.gz.</summary>
public sealed class ProfileStore : JsonCollection<ProfileInfo>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _dir;
    private readonly ConcurrentDictionary<(string Service, string Instance), ProfilingInstance> _instances = new();

    public ProfileStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
        : base(o.Value.ResolveDataDirectory(env.ContentRootPath), "profiles.json")
    {
        _dir = Path.Combine(o.Value.ResolveDataDirectory(env.ContentRootPath), "profiles");
        Directory.CreateDirectory(_dir);
    }

    /// <summary>Appelé à chaque interrogation d'une instance : la déclare disponible et lui remet ses demandes.</summary>
    public List<ProfileRequest> Poll(string service, string instance, string? host, string? version, string? runtime)
    {
        _instances[(service, instance)] = new ProfilingInstance(service, instance, host, version, runtime, DateTime.UtcNow);
        var pending = All().Where(p => p.Status == "pending" && p.Service == service && (p.Instance == instance || p.Instance == "*")).ToList();
        var list = new List<ProfileRequest>();
        foreach (var p in pending)
        {
            // Demande « n'importe quelle instance » : attribuée à la première qui se présente.
            Update(p.Id, x => { x.Instance = instance; x.Host = host; x.Version = version; x.Status = "running"; x.Start = DateTime.UtcNow; });
            list.Add(new ProfileRequest(p.Id, service, instance, p.Kind, (int)p.Seconds, p.RequestedAt, p.RequestedBy));
        }
        return list;
    }

    public IReadOnlyList<ProfilingInstance> Instances() =>
        _instances.Values.Where(i => DateTime.UtcNow - i.LastSeen < TimeSpan.FromMinutes(2)).OrderBy(i => i.Service).ThenBy(i => i.Host).ToList();

    public ProfileInfo Request(string service, string? instance, string kind, int seconds, string? by) => Upsert(new ProfileInfo
    {
        Service = service, Instance = string.IsNullOrEmpty(instance) ? "*" : instance, Kind = kind == "alloc" ? "alloc" : "cpu",
        Seconds = Math.Clamp(seconds, 5, 120), RequestedBy = by, Status = "pending",
    });

    /// <summary>Identifiant généré par Wolflog (lettres et chiffres) : jamais un chemin.</summary>
    public static bool IsValidId(string? id) => id is { Length: > 0 and <= 32 } && id.All(char.IsAsciiLetterOrDigit);

    public void Save(string id, ProfileInfo info, IEnumerable<StackWeight> stacks)
    {
        if (!IsValidId(id)) throw new ArgumentException("Identifiant de profil invalide.", nameof(id));
        var list = stacks.ToList();
        // Écriture atomique : une lecture simultanée voit l'ancien fichier ou le nouveau, jamais un fichier à moitié écrit.
        var path = Path.Combine(_dir, id + ".json.gz");
        var tmp = path + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
        using (var file = File.Create(tmp))
        using (var gzip = new GZipStream(file, CompressionLevel.Optimal))
            JsonSerializer.Serialize(gzip, list, Json);
        File.Move(tmp, path, overwrite: true);
        info.Id = id;
        info.Total = list.Sum(s => s.V);
        info.Status = info.Error is null ? "done" : "failed";
        Upsert(info);
    }

    public List<StackWeight>? Stacks(string id)
    {
        if (!IsValidId(id)) return null;
        var path = Path.Combine(_dir, id + ".json.gz");
        if (!File.Exists(path)) return null;
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var gzip = new GZipStream(file, CompressionMode.Decompress);
        return JsonSerializer.Deserialize<List<StackWeight>>(gzip, Json);
    }

    public void Remove(string id)
    {
        if (!IsValidId(id)) return;
        Delete(id);
        var path = Path.Combine(_dir, id + ".json.gz");
        if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>Demandes restées sans réponse (instance arrêtée) : marquées en échec.</summary>
    public void Expire()
    {
        foreach (var p in All().Where(p => p.Status is "pending" or "running" && DateTime.UtcNow - p.RequestedAt > TimeSpan.FromSeconds(p.Seconds + 90)))
        {
            var error = p.Status == "pending"
                ? "Aucune instance n'a pris la demande (paquet Wolflog.Client.Profiling installé ?)"
                : "Pas de résultat reçu de l'instance";
            Update(p.Id, x => { x.Status = "failed"; x.Error = error; });
        }
    }
}
