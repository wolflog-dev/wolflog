using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;

namespace Wolflog.Server.Monitoring;

/// <summary>
/// Jetons Microsoft des messageries connectées en OAuth (sondes e-mail, notifications) : connexion d'un compte par code
/// (« device code » : le code est saisi sur microsoft.com/devicelogin, aucune adresse de retour à déclarer), jeton de
/// renouvellement conservé chiffré puis échangé contre un jeton d'accès, ou jeton d'application (client credentials).
/// Les jetons d'accès sont gardés en mémoire jusqu'à leur expiration ; un jeton n'est présenté qu'aux serveurs de Microsoft.
/// </summary>
public sealed class MicrosoftMailTokens(IHttpClientFactory http, IDataProtectionProvider protection, IOptions<WolflogServerOptions> options,
    ILogger<MicrosoftMailTokens> log)
{
    public const string HttpClientName = "microsoft-mail";
    /// <summary>Compte connecté : envoi SMTP et lecture IMAP (même ressource), et renouvellement sans nouvelle connexion.</summary>
    public const string AccountScopes = "offline_access openid email profile https://outlook.office.com/SMTP.Send https://outlook.office.com/IMAP.AccessAsUser.All";
    /// <summary>Application : permissions accordées par l'administrateur (SMTP.SendAsApp, IMAP.AccessAsApp).</summary>
    public const string AppScope = "https://outlook.office365.com/.default";
    private const string DeviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

    /// <summary>Connexion par code en cours ou aboutie (gardée une heure : test puis enregistrement).</summary>
    public sealed record DeviceStart(string Id, string UserCode, string VerificationUri, int ExpiresIn, int Interval);

    /// <summary>pending, ok ou error.</summary>
    public sealed record DeviceStatus(string Status, string? Account, string? Error);

    private sealed class Flow
    {
        public required string Owner { get; init; }
        public required string Tenant { get; init; }
        public required string ClientId { get; init; }
        public required string DeviceCode { get; init; }
        public required DateTime ExpiresAt { get; init; }
        public int Interval { get; set; }
        public DateTime NextPoll { get; set; }
        public string? ProtectedRefreshToken { get; set; }
        public string? Account { get; set; }
        public string? Error { get; set; }
    }

    private readonly IDataProtector _protector = protection.CreateProtector("Wolflog.Mail.Microsoft");
    private readonly ConcurrentDictionary<string, (string Token, DateTime Expires)> _tokens = new();
    private readonly ConcurrentDictionary<string, Flow> _flows = new();

    private string Authority => options.Value.Mail.MicrosoftAuthority.TrimEnd('/');

    /// <summary>Serveur à qui un jeton Microsoft peut être présenté (jamais un autre, qui pourrait s'en resservir).</summary>
    public bool IsMicrosoftHost(string? host)
    {
        var h = host?.Trim().TrimEnd('.').ToLowerInvariant();
        return !string.IsNullOrEmpty(h) && options.Value.Mail.MicrosoftHosts.Any(s =>
        {
            var suffix = s.Trim().TrimStart('.').ToLowerInvariant();
            return suffix.Length > 0 && (h == suffix || h.EndsWith("." + suffix, StringComparison.Ordinal));
        });
    }

    /// <summary>Annuaire par défaut : celui du domaine de la boîte (domaine vérifié du locataire), « consumers » pour Outlook.com.</summary>
    public static string DefaultTenant(string? address)
    {
        var domain = address?.Split('@').LastOrDefault()?.Trim().TrimEnd('>').ToLowerInvariant();
        return domain switch
        {
            null or "" => "organizations",
            "outlook.com" or "outlook.fr" or "hotmail.com" or "hotmail.fr" or "live.com" or "live.fr" or "msn.com" => "consumers",
            _ => domain,
        };
    }

    // ------------------------------------------------------------------ secrets

    public string Protect(string value) => _protector.Protect(value);

    public string? Unprotect(string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        try { return _protector.Unprotect(value); }
        catch (CryptographicException) { return null; }
    }

    /// <summary>
    /// Prépare les réglages reçus de l'interface : secret saisi chiffré, sinon celui enregistré pour la même application ;
    /// connexion qui vient d'aboutir rattachée, sinon celle enregistrée pour la même application et le même compte.
    /// </summary>
    public void Prepare(MicrosoftMailAuth incoming, MicrosoftMailAuth? existing, string owner)
    {
        incoming.Mode = incoming.Mode == "app" ? "app" : "account";
        incoming.Tenant = SsoSettings.NormalizeTenant(incoming.Tenant);
        incoming.ClientId = incoming.ClientId?.Trim();
        var sameApp = existing is not null && Same(incoming.Tenant, existing.Tenant) && Same(incoming.ClientId, existing.ClientId);

        incoming.ProtectedClientSecret = incoming.Mode != "app" ? null
            : !string.IsNullOrEmpty(incoming.ClientSecret) ? Protect(incoming.ClientSecret.Trim())
            : sameApp ? existing!.ProtectedClientSecret : null;

        if (incoming.Mode != "account")
        {
            incoming.ProtectedRefreshToken = null;
            incoming.Account = null;
        }
        else if (incoming.ConnectionId is { } id && _flows.TryGetValue(id, out var flow) && flow.Owner == owner && flow.ProtectedRefreshToken is not null
                 && Same(flow.Tenant, incoming.Tenant) && Same(flow.ClientId, incoming.ClientId))
        {
            incoming.ProtectedRefreshToken = flow.ProtectedRefreshToken;
            incoming.Account = flow.Account;
        }
        else if (sameApp && existing!.ProtectedRefreshToken is not null)
        {
            incoming.ProtectedRefreshToken = existing.ProtectedRefreshToken;
            incoming.Account = existing.Account;
        }
        else
        {
            incoming.ProtectedRefreshToken = null;
            incoming.Account = null;
        }
        incoming.ClientSecret = null;
        incoming.ConnectionId = null;
        incoming.HasClientSecret = incoming.Connected = false;
    }

    /// <summary>Copie pour l'interface : aucun secret, seulement s'il y en a un.</summary>
    public static MicrosoftMailAuth ForDisplay(MicrosoftMailAuth a)
    {
        var copy = a.Copy();
        copy.HasClientSecret = !string.IsNullOrEmpty(a.ProtectedClientSecret);
        copy.Connected = !string.IsNullOrEmpty(a.ProtectedRefreshToken);
        copy.ProtectedClientSecret = copy.ProtectedRefreshToken = copy.ClientSecret = copy.ConnectionId = null;
        return copy;
    }

    private static bool Same(string? a, string? b) => string.Equals(a?.Trim(), b?.Trim(), StringComparison.OrdinalIgnoreCase);

    // ------------------------------------------------------------------ jetons d'accès

    /// <summary>
    /// Jeton d'accès SMTP / IMAP. Compte connecté : <paramref name="rotated"/> reçoit le nouveau jeton de renouvellement
    /// (chiffré), à enregistrer à la place de l'ancien (il expire 90 jours après sa délivrance).
    /// </summary>
    public async Task<string> AccessTokenAsync(MicrosoftMailAuth a, Action<string>? rotated, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(a.ClientId)) throw new MicrosoftMailException("ID d'application (client) Microsoft manquant.");
        var tenant = SsoSettings.NormalizeTenant(a.Tenant) ?? "organizations";
        Dictionary<string, string> form;
        string key;
        if (a.Mode == "app")
        {
            var secret = Unprotect(a.ProtectedClientSecret) ?? throw new MicrosoftMailException("Secret de l'application Microsoft manquant : saisissez-le de nouveau.");
            key = Key("app", tenant, a.ClientId, secret);
            form = new() { ["grant_type"] = "client_credentials", ["client_id"] = a.ClientId.Trim(), ["client_secret"] = secret, ["scope"] = AppScope };
        }
        else
        {
            var refresh = Unprotect(a.ProtectedRefreshToken)
                ?? throw new MicrosoftMailException("Compte Microsoft non connecté : cliquez sur « Se connecter avec Microsoft ».");
            key = Key("account", tenant, a.ClientId, refresh);
            form = new() { ["grant_type"] = "refresh_token", ["client_id"] = a.ClientId.Trim(), ["refresh_token"] = refresh, ["scope"] = AccountScopes };
        }
        if (_tokens.TryGetValue(key, out var cached) && cached.Expires > DateTime.UtcNow) return cached.Token;

        var (ok, body) = await PostAsync(tenant, "token", form, ct);
        if (!ok) throw new MicrosoftMailException(Explain(body, a.Mode));
        var token = Text(body, "access_token") ?? throw new MicrosoftMailException("Réponse de Microsoft sans jeton d'accès.");
        var expires = DateTime.UtcNow.AddSeconds(Math.Max(60, Number(body, "expires_in") ?? 3600) - 120);
        if (a.Mode != "app" && Text(body, "refresh_token") is { } next)
        {
            var protectedNext = Protect(next);
            rotated?.Invoke(protectedNext);
            // Le jeton d'accès reste valable : il est aussi retrouvé à partir du nouveau jeton de renouvellement.
            _tokens[Key("account", tenant, a.ClientId, next)] = (token, expires);
        }
        _tokens[key] = (token, expires);
        return token;
    }

    /// <summary>Oublie les jetons d'accès gardés en mémoire (tests : forcer un renouvellement).</summary>
    internal void ForgetAccessTokens() => _tokens.Clear();

    private static string Key(string mode, string tenant, string clientId, string secret) =>
        $"{mode}|{tenant}|{clientId.Trim().ToLowerInvariant()}|{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(secret)))}";

    // ------------------------------------------------------------------ connexion d'un compte par code

    public async Task<DeviceStart> StartAsync(string? tenantInput, string? clientId, string owner, CancellationToken ct)
    {
        foreach (var (id, old) in _flows)
            if (old.ExpiresAt < DateTime.UtcNow.AddHours(-1)) _flows.TryRemove(id, out _);
        var tenant = SsoSettings.NormalizeTenant(tenantInput) ?? "organizations";
        if (!Guid.TryParse(clientId?.Trim(), out _))
            throw new MicrosoftMailException("L'ID d'application (client) est un GUID : copiez-le depuis la « Vue d'ensemble » de l'inscription Entra ID.");
        var (ok, body) = await PostAsync(tenant, "devicecode", new() { ["client_id"] = clientId!.Trim(), ["scope"] = AccountScopes }, ct);
        if (!ok) throw new MicrosoftMailException(Explain(body, "account"));
        var flow = new Flow
        {
            Owner = owner, Tenant = tenant, ClientId = clientId.Trim(),
            DeviceCode = Text(body, "device_code") ?? throw new MicrosoftMailException("Réponse de Microsoft incomplète."),
            ExpiresAt = DateTime.UtcNow.AddSeconds(Number(body, "expires_in") ?? 900),
            Interval = (int)(Number(body, "interval") ?? 5),
        };
        var flowId = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        _flows[flowId] = flow;
        return new DeviceStart(flowId, Text(body, "user_code") ?? "", Text(body, "verification_uri") ?? "https://microsoft.com/devicelogin",
            (int)(flow.ExpiresAt - DateTime.UtcNow).TotalSeconds, flow.Interval);
    }

    /// <summary>Où en est la connexion : le code a-t-il été saisi et accepté chez Microsoft ?</summary>
    public async Task<DeviceStatus> PollAsync(string id, string owner, CancellationToken ct)
    {
        if (!_flows.TryGetValue(id, out var flow) || flow.Owner != owner) return new("error", null, "Connexion introuvable : recommencez.");
        if (flow.ProtectedRefreshToken is not null) return new("ok", flow.Account, null);
        if (flow.Error is not null) return new("error", null, flow.Error);
        if (DateTime.UtcNow > flow.ExpiresAt) return new("error", null, "Code expiré sans avoir été saisi : recommencez.");
        if (DateTime.UtcNow < flow.NextPoll) return new("pending", null, null);
        flow.NextPoll = DateTime.UtcNow.AddSeconds(flow.Interval);

        var (ok, body) = await PostAsync(flow.Tenant, "token", new()
        {
            ["grant_type"] = DeviceGrant, ["client_id"] = flow.ClientId, ["device_code"] = flow.DeviceCode,
        }, ct);
        if (!ok)
        {
            switch (Text(body, "error"))
            {
                case "authorization_pending":
                    return new("pending", null, null);
                case "slow_down":
                    flow.Interval += 5;
                    return new("pending", null, null);
                case "authorization_declined" or "access_denied":
                    flow.Error = "Connexion refusée sur la page de Microsoft.";
                    break;
                case "expired_token":
                    flow.Error = "Code expiré sans avoir été saisi : recommencez.";
                    break;
                default:
                    flow.Error = Explain(body, "account");
                    break;
            }
            return new("error", null, flow.Error);
        }
        var refresh = Text(body, "refresh_token");
        if (refresh is null)
        {
            flow.Error = "Microsoft n'a pas délivré de jeton de renouvellement (autorisation offline_access refusée ?).";
            return new("error", null, flow.Error);
        }
        flow.Account = AccountOf(Text(body, "id_token"));
        flow.ProtectedRefreshToken = Protect(refresh);
        if (Text(body, "access_token") is { } access)
            _tokens[Key("account", flow.Tenant, flow.ClientId, refresh)] = (access, DateTime.UtcNow.AddSeconds(Math.Max(60, Number(body, "expires_in") ?? 3600) - 120));
        log.LogInformation("Messagerie Microsoft connectée : {Account}", flow.Account);
        return new("ok", flow.Account, null);
    }

    /// <summary>Adresse du compte d'après le jeton d'identité (preferred_username, sinon email, sinon upn).</summary>
    private static string? AccountOf(string? idToken)
    {
        var parts = idToken?.Split('.');
        if (parts is not { Length: >= 2 }) return null;
        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + ((4 - (payload.Length % 4)) % 4), '=');
            var json = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
            return Text(json, "preferred_username") ?? Text(json, "email") ?? Text(json, "upn");
        }
        catch (FormatException)
        {
            return null;
        }
    }

    // ------------------------------------------------------------------ échanges avec Microsoft

    private async Task<(bool Ok, string Body)> PostAsync(string tenant, string endpoint, Dictionary<string, string> form, CancellationToken ct)
    {
        try
        {
            using var content = new FormUrlEncodedContent(form);
            using var response = await http.CreateClient(HttpClientName).PostAsync($"{Authority}/{Uri.EscapeDataString(tenant)}/oauth2/v2.0/{endpoint}", content, ct);
            return (response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync(ct));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new MicrosoftMailException(ex is TaskCanceledException
                ? "Microsoft n'a pas répondu à temps : vérifiez l'accès Internet du serveur Wolflog (proxy sortant, pare-feu)."
                : $"Impossible de joindre {new Uri(Authority).Host} depuis le serveur Wolflog ({ex.Message}) : vérifiez son accès Internet.");
        }
    }

    private static readonly Dictionary<string, string> Advice = new()
    {
        ["50194"] = "Cette application n'accepte que les comptes de son annuaire : indiquez l'ID de l'annuaire (ou son domaine) au lieu de « common ».",
        ["9002346"] = "Cette application n'accepte que les comptes Microsoft personnels : indiquez « consumers » comme annuaire.",
        ["700016"] = "Application introuvable dans cet annuaire : vérifiez l'ID d'application (client) et l'annuaire (domaine de l'adresse, ou ID de l'annuaire).",
        ["7000218"] = "L'application n'autorise pas la connexion par code : dans Entra ID > l'inscription > Authentification, activez « Autoriser les flux clients publics ».",
        ["65001"] = "Autorisations non accordées : ajoutez SMTP.Send et IMAP.AccessAsUser.All (Autorisations d'API) et faites accorder le consentement par un administrateur.",
        ["700082"] = "Connexion expirée (inutilisée trop longtemps) : reconnectez le compte Microsoft.",
        ["50173"] = "Le mot de passe du compte a changé : reconnectez le compte Microsoft.",
        ["50076"] = "Une authentification multifacteur est de nouveau demandée : reconnectez le compte Microsoft.",
        ["50078"] = "Une authentification multifacteur est de nouveau demandée : reconnectez le compte Microsoft.",
        ["70000"] = "Connexion révoquée ou expirée : reconnectez le compte Microsoft.",
        ["1002016"] = "Microsoft exige TLS 1.2 ou plus récent sur le serveur Wolflog.",
    };

    /// <summary>Erreur de Microsoft (AADSTS…) traduite en consigne.</summary>
    private static string Explain(string body, string mode)
    {
        var message = Text(body, "error_description") ?? Text(body, "error") ?? "réponse inattendue de Microsoft";
        var code = System.Text.RegularExpressions.Regex.Match(message, @"AADSTS(\d+)");
        // 7000218 : secret manquant pour une application, connexion par code non autorisée pour un compte.
        if (code.Success && !(mode == "app" && code.Groups[1].Value == "7000218") && Advice.TryGetValue(code.Groups[1].Value, out var advice))
            return $"{advice} (AADSTS{code.Groups[1].Value})";
        return "Microsoft : " + EntraCheck.Explain(message);
    }

    private static string? Text(string json, string name)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        }
        catch (JsonException) { return null; }
    }

    private static double? Number(string json, string name)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty(name, out var v)) return null;
            return v.ValueKind == JsonValueKind.Number ? v.GetDouble()
                : v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
        }
        catch (JsonException) { return null; }
    }
}
