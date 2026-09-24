using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Vigil.Server.Security;

/// <summary>
/// Identifiants effectifs : ceux de la configuration, sinon ceux générés au premier démarrage
/// (stockés dans &lt;data&gt;/secrets.json). Sécurisé par défaut, sans configuration obligatoire.
/// </summary>
public sealed class AuthService
{
    public sealed class Secrets
    {
        public string AdminPassword { get; set; } = "";
        public List<string> ApiKeys { get; set; } = [];
    }

    private readonly HashSet<string> _apiKeys;
    private readonly string _adminUser;
    private readonly string _adminPassword;

    public bool Enabled { get; }
    public string SecretsPath { get; }
    public bool GeneratedNow { get; }
    public string AdminUser => _adminUser;
    public string PrimaryApiKey { get; }
    public bool PasswordFromSecretsFile { get; }

    public AuthService(IOptions<VigilServerOptions> options, IHostEnvironment env, ILogger<AuthService> log)
    {
        var o = options.Value;
        Enabled = o.Auth.Enabled;
        _adminUser = string.IsNullOrWhiteSpace(o.Auth.AdminUser) ? "admin" : o.Auth.AdminUser;
        var dataDir = o.ResolveDataDirectory(env.ContentRootPath);
        Directory.CreateDirectory(dataDir);
        SecretsPath = Path.Combine(dataDir, "secrets.json");

        Secrets? secrets = null;
        var needsSecrets = string.IsNullOrEmpty(o.Auth.AdminPassword) || o.Auth.ApiKeys.Count == 0;
        if (needsSecrets)
        {
            if (File.Exists(SecretsPath))
            {
                secrets = JsonSerializer.Deserialize<Secrets>(File.ReadAllText(SecretsPath));
            }
            if (secrets is null || string.IsNullOrEmpty(secrets.AdminPassword) || secrets.ApiKeys.Count == 0)
            {
                secrets = new Secrets { AdminPassword = NewSecret(18), ApiKeys = [NewSecret(32)] };
                File.WriteAllText(SecretsPath, JsonSerializer.Serialize(secrets, new JsonSerializerOptions { WriteIndented = true }));
                GeneratedNow = true;
            }
        }

        _adminPassword = !string.IsNullOrEmpty(o.Auth.AdminPassword) ? o.Auth.AdminPassword : secrets!.AdminPassword;
        PasswordFromSecretsFile = string.IsNullOrEmpty(o.Auth.AdminPassword);
        var keys = o.Auth.ApiKeys.Count > 0 ? o.Auth.ApiKeys : secrets!.ApiKeys;
        _apiKeys = new HashSet<string>(keys.Where(k => !string.IsNullOrWhiteSpace(k)), StringComparer.Ordinal);
        PrimaryApiKey = keys.FirstOrDefault() ?? "";

        if (!Enabled)
        {
            log.LogWarning("Authentification DÉSACTIVÉE (Vigil:Auth:Enabled=false) : à réserver au développement local.");
        }
        else if (GeneratedNow)
        {
            log.LogWarning("""
                Premier démarrage : identifiants générés (conservés dans {Path})
                  Interface : utilisateur '{User}' / mot de passe '{Password}'
                  Clé API d'ingestion : {ApiKey}
                """, SecretsPath, _adminUser, _adminPassword, PrimaryApiKey);
        }
        else
        {
            log.LogInformation("Identifiants : {Path} (commande 'vigil credentials' pour les afficher)", PasswordFromSecretsFile ? SecretsPath : "configuration");
        }
    }

    public bool ValidateUser(string? user, string? password)
    {
        if (user is null || password is null) return false;
        return FixedEquals(user, _adminUser) & FixedEquals(password, _adminPassword);
    }

    public bool ValidateApiKey(string? key)
    {
        if (!Enabled) return true;
        if (string.IsNullOrEmpty(key)) return false;
        foreach (var k in _apiKeys)
            if (FixedEquals(k, key)) return true;
        return false;
    }

    /// <summary>Extrait la clé : en-tête x-vigil-key, api-key ou Authorization: Bearer.</summary>
    public static string? ReadApiKey(IHeaderDictionary headers)
    {
        if (headers.TryGetValue("x-vigil-key", out var v) && v.Count > 0) return v[0];
        if (headers.TryGetValue("api-key", out v) && v.Count > 0) return v[0];
        var auth = headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return auth[7..].Trim();
        return null;
    }

    private static bool FixedEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));

    public static string NewSecret(int bytes) =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', 'x').Replace('/', 'y');
}
