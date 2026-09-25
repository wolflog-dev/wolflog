using System.Security.Cryptography;

namespace Wolflog.Server.Security;

/// <summary>
/// Comptes utilisateurs, clés d'ingestion et SSO.
/// Premier démarrage sans configuration : compte admin et clé générés (voir &lt;data&gt;/secrets.json).
/// </summary>
public sealed class AuthService : IDisposable
{
    public sealed class Secrets
    {
        public string AdminPassword { get; set; } = "";
        public List<string> ApiKeys { get; set; } = [];
    }

    private readonly HashSet<string> _configKeys;
    private readonly Timer _flush;

    public bool Enabled { get; }
    public string SecretsPath { get; }
    public bool GeneratedNow { get; }
    public string PrimaryApiKey { get; }
    public UserStore Users { get; }
    public ApiKeyStore Keys { get; }
    public WolflogServerOptions.OidcOptions? Oidc { get; }

    public AuthService(IOptions<WolflogServerOptions> options, IHostEnvironment env, ILogger<AuthService> log)
    {
        var o = options.Value;
        Enabled = o.Auth.Enabled;
        var adminUser = string.IsNullOrWhiteSpace(o.Auth.AdminUser) ? "admin" : o.Auth.AdminUser;
        var dataDir = o.ResolveDataDirectory(env.ContentRootPath);
        Directory.CreateDirectory(dataDir);
        SecretsPath = Path.Combine(dataDir, "secrets.json");
        Users = new UserStore(dataDir);
        Keys = new ApiKeyStore(dataDir);
        Oidc = string.IsNullOrWhiteSpace(o.Auth.Oidc.Authority) ? null : o.Auth.Oidc;

        Secrets? secrets = null;
        if (string.IsNullOrEmpty(o.Auth.AdminPassword) || o.Auth.ApiKeys.Count == 0)
        {
            if (File.Exists(SecretsPath)) secrets = JsonSerializer.Deserialize<Secrets>(File.ReadAllText(SecretsPath));
            if (secrets is null || string.IsNullOrEmpty(secrets.AdminPassword) || secrets.ApiKeys.Count == 0)
            {
                secrets = new Secrets { AdminPassword = Passwords.Generate(18), ApiKeys = [Passwords.Generate(32)] };
                File.WriteAllText(SecretsPath, JsonSerializer.Serialize(secrets, new JsonSerializerOptions { WriteIndented = true }));
                GeneratedNow = true;
            }
        }
        var adminPassword = !string.IsNullOrEmpty(o.Auth.AdminPassword) ? o.Auth.AdminPassword : secrets!.AdminPassword;
        var keys = o.Auth.ApiKeys.Count > 0 ? o.Auth.ApiKeys : secrets!.ApiKeys;
        _configKeys = new HashSet<string>(keys.Where(k => !string.IsNullOrWhiteSpace(k)), StringComparer.Ordinal);
        PrimaryApiKey = keys.FirstOrDefault() ?? "";

        // Premier démarrage : compte administrateur initial.
        if (Users.All().Count == 0)
        {
            Users.Upsert(new User { Username = adminUser, DisplayName = "Administrateur", Role = Roles.Admin, PasswordHash = Passwords.Hash(adminPassword) });
        }

        _flush = new Timer(_ => { try { Keys.FlushUsage(); } catch { /* réessayé plus tard */ } }, null, 60_000, 60_000);

        if (!Enabled)
            log.LogWarning("Authentification DÉSACTIVÉE (Wolflog:Auth:Enabled=false) : à réserver au développement local.");
        else if (GeneratedNow)
            log.LogWarning("""
                Premier démarrage : identifiants générés (conservés dans {Path})
                  Interface : utilisateur '{User}' / mot de passe '{Password}'
                  Clé API d'ingestion : {ApiKey}
                """, SecretsPath, adminUser, adminPassword, PrimaryApiKey);
        else
            log.LogInformation("Comptes : {Count} utilisateur(s). Mot de passe perdu : 'wolflog reset-password <utilisateur>'.", Users.All().Count);
    }

    public User? ValidateUser(string? username, string? password)
    {
        if (username is null || password is null) return null;
        return Users.Verify(username, password);
    }

    /// <summary>Clé d'ingestion valide (configuration ou créée dans l'interface) ; null sinon.</summary>
    public IngestKey? ValidateApiKey(string? key)
    {
        if (!Enabled) return new IngestKey("authentification désactivée", "server", []);
        if (string.IsNullOrEmpty(key)) return null;
        foreach (var k in _configKeys)
            if (FixedEquals(k, key)) return new IngestKey("clé de configuration", "server", []);
        var record = Keys.Match(key);
        return record is null ? null : new IngestKey(record.Name, record.Kind, record.AllowedOrigins);
    }

    public int ConfigKeyCount => _configKeys.Count;

    /// <summary>Extrait la clé : en-tête x-wolflog-key, api-key ou Authorization: Bearer.</summary>
    public static string? ReadApiKey(IHeaderDictionary headers)
    {
        if (headers.TryGetValue("x-wolflog-key", out var v) && v.Count > 0) return v[0];
        if (headers.TryGetValue("api-key", out v) && v.Count > 0) return v[0];
        var auth = headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return auth[7..].Trim();
        return null;
    }

    private static bool FixedEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));

    public static string NewSecret(int bytes) => Passwords.Generate(bytes);

    public void Dispose()
    {
        _flush.Dispose();
        Keys.FlushUsage();
    }
}
