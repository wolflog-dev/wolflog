using System.Security.Cryptography;

namespace Wolflog.Server.Security;

public sealed class ApiKeyStore : JsonCollection<ApiKeyRecord>
{
    private readonly ConcurrentDictionary<string, DateTime> _lastUsed = new();
    private volatile Dictionary<string, ApiKeyRecord> _byHash = new();
    private DateTime _indexStamp = DateTime.MinValue;

    public ApiKeyStore(string dataDirectory) : base(dataDirectory, "apikeys.json") => RebuildIndex();

    public static string HashOf(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));

    /// <summary>Crée une clé ; retourne l'enregistrement et la clé en clair (affichée une seule fois).</summary>
    public (ApiKeyRecord Record, string Key) Create(string name, string kind, IEnumerable<string>? origins, string? createdBy)
    {
        var key = (kind == "browser" ? "wlb_" : "wlk_") + Passwords.Generate(24);
        var record = Upsert(new ApiKeyRecord
        {
            Name = name.Trim(),
            Kind = kind == "browser" ? "browser" : "server",
            Prefix = key[..10],
            Hash = HashOf(key),
            AllowedOrigins = origins?.Select(o => o.Trim().TrimEnd('/')).Where(o => o.Length > 0).ToList() ?? [],
            CreatedBy = createdBy,
        });
        RebuildIndex();
        return (record, key);
    }

    public ApiKeyRecord? Revoke(string id)
    {
        var r = Update(id, k => k.RevokedAt ??= DateTime.UtcNow);
        RebuildIndex();
        return r;
    }

    /// <summary>Clé active correspondant à la valeur reçue (null si inconnue ou révoquée).</summary>
    public ApiKeyRecord? Match(string key)
    {
        if (File.Exists(FilePath) && File.GetLastWriteTimeUtc(FilePath) != _indexStamp) RebuildIndex();
        if (!_byHash.TryGetValue(HashOf(key), out var record)) return null;
        _lastUsed[record.Id] = DateTime.UtcNow;
        return record;
    }

    /// <summary>Enregistre les dates de dernière utilisation (appelé périodiquement, pas à chaque requête).</summary>
    public void FlushUsage()
    {
        foreach (var (id, at) in _lastUsed.ToArray())
        {
            _lastUsed.TryRemove(id, out _);
            Update(id, k => k.LastUsedAt = at);
        }
        _indexStamp = File.Exists(FilePath) ? File.GetLastWriteTimeUtc(FilePath) : DateTime.MinValue;
    }

    private void RebuildIndex()
    {
        _byHash = All().Where(k => k.RevokedAt is null).ToDictionary(k => k.Hash);
        _indexStamp = File.Exists(FilePath) ? File.GetLastWriteTimeUtc(FilePath) : DateTime.MinValue;
    }
}
