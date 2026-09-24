using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Vigil.Server.Configuration;

namespace Vigil.Server.Security;

public static class Roles
{
    public const string Viewer = "viewer";
    public const string Editor = "editor";
    public const string Admin = "admin";

    public static bool IsValid(string? role) => role is Viewer or Editor or Admin;

    /// <summary>admin ⊃ editor ⊃ viewer.</summary>
    public static bool Allows(string? role, string required) => required switch
    {
        Admin => role == Admin,
        Editor => role is Admin or Editor,
        _ => IsValid(role),
    };
}

public sealed class User : IEntity
{
    public string Id { get; set; } = "";
    public string Username { get; set; } = "";
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
    public string Role { get; set; } = Roles.Viewer;
    /// <summary>local ou sso.</summary>
    public string Source { get; set; } = "local";
    public string? PasswordHash { get; set; }
    public bool MustChangePassword { get; set; }
    public bool Disabled { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastLoginAt { get; set; }
}

public static class Passwords
{
    private const int Iterations = 120_000;

    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verify(string password, string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return false;
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2") return false;
        var iterations = int.Parse(parts[1]);
        var salt = Convert.FromBase64String(parts[2]);
        var expected = Convert.FromBase64String(parts[3]);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    public static string Generate(int bytes = 12) =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', 'x').Replace('/', 'y');
}

public sealed class UserStore(string dataDirectory) : JsonCollection<User>(dataDirectory, "users.json")
{
    public User? ByUsername(string username) =>
        Find(u => string.Equals(u.Username, username, StringComparison.OrdinalIgnoreCase));

    public User? Verify(string username, string password)
    {
        var user = ByUsername(username);
        if (user is null || user.Disabled || user.Source != "local") return null;
        if (!Passwords.Verify(password, user.PasswordHash)) return null;
        return Update(user.Id, u => u.LastLoginAt = DateTime.UtcNow);
    }
}

/// <summary>Clé d'ingestion. La clé elle-même n'est jamais stockée : seulement son empreinte SHA-256.</summary>
public sealed class ApiKeyRecord : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>server (applications) ou browser (script navigateur, visible publiquement : envoi RUM uniquement).</summary>
    public string Kind { get; set; } = "server";
    public string Prefix { get; set; } = "";
    public string Hash { get; set; } = "";
    public List<string> AllowedOrigins { get; set; } = [];
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public string? CreatedBy { get; set; }
    public DateTime? LastUsedAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}

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
        var key = (kind == "browser" ? "vgb_" : "vgl_") + Passwords.Generate(24);
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
