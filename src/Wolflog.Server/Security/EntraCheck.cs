using System.Text.RegularExpressions;

namespace Wolflog.Server.Security;

/// <summary>
/// Vérification d'une inscription Microsoft Entra ID depuis le serveur : le locataire (document de configuration OpenID),
/// puis l'application et son secret (jeton d'application demandé puis aussitôt oublié). Les erreurs de Microsoft
/// (AADSTS…) sont traduites en consignes, ici comme dans le dernier échec de connexion.
/// </summary>
public static partial class EntraCheck
{
    public sealed record Report(bool Ok, string? TenantId, List<CheckStep> Steps);

    private const string TenantStep = "Locataire";
    private const string ApplicationStep = "Application et secret";

    private static readonly Dictionary<string, string> Advice = new()
    {
        ["90002"] = "Locataire introuvable : vérifiez l'ID de l'annuaire (locataire) ou le domaine (ex. contoso.onmicrosoft.com).",
        ["900023"] = "Locataire invalide : indiquez l'ID de l'annuaire (GUID) ou un domaine vérifié du locataire.",
        ["700016"] = "Application introuvable dans ce locataire : vérifiez l'ID d'application (client) et le locataire de l'inscription.",
        ["7000215"] = "Secret client invalide : copiez la « Valeur » du secret, et non son « ID de secret ».",
        ["7000222"] = "Secret client expiré : créez-en un nouveau dans « Certificats et secrets ».",
        ["7000218"] = "Secret client manquant : saisissez-le dans Wolflog.",
        ["50011"] = "L'URI de redirection envoyée n'est pas déclarée : ajoutez exactement celle indiquée par Wolflog (plateforme Web).",
        ["500113"] = "Aucune URI de redirection n'est déclarée : ajoutez celle indiquée par Wolflog (plateforme Web).",
        ["50020"] = "Ce compte n'appartient pas au locataire : invitez-le dans l'annuaire, ou utilisez un compte de l'organisation.",
        ["50105"] = "Ce compte n'est pas affecté à l'application : ajoutez-le (ou son groupe) dans Applications d'entreprise > Utilisateurs et groupes.",
        ["65001"] = "Consentement manquant : un administrateur doit l'accorder dans Autorisations d'API.",
        ["53003"] = "Accès bloqué par une stratégie d'accès conditionnel du locataire.",
        ["90072"] = "Ce compte n'existe pas dans le locataire : connectez-vous avec un compte de l'organisation.",
    };

    [GeneratedRegex(@"AADSTS(\d+)")]
    private static partial Regex ErrorCode();

    [GeneratedRegex(@"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOptions.IgnoreCase)]
    private static partial Regex GuidPattern();

    /// <summary>Message de Microsoft (« AADSTS7000215: Invalid client secret… ») traduit en consigne, code compris.</summary>
    public static string Explain(string message)
    {
        var code = ErrorCode().Match(message);
        if (code.Success && Advice.TryGetValue(code.Groups[1].Value, out var advice)) return $"{advice} (AADSTS{code.Groups[1].Value})";
        // Erreur non répertoriée : première ligne du message d'origine, sans l'identifiant de trace qui suit.
        var line = message.Split('\n', 2)[0].Trim();
        return line.Length > 300 ? line[..300] + "…" : line;
    }

    public static async Task<Report> RunAsync(HttpClient http, string? tenantInput, string? clientId, string? secret, CancellationToken ct)
    {
        var steps = new List<CheckStep>();
        var tenant = SsoSettings.NormalizeTenant(tenantInput);
        if (SsoSettings.TenantError(tenant) is { } invalid)
        {
            steps.Add(new(TenantStep, false, invalid));
            return new(false, null, steps);
        }

        // 1. Le locataire existe : son document de configuration OpenID répond.
        string? tenantId;
        try
        {
            using var response = await http.GetAsync(SsoSettings.AuthorityOf(tenant!) + "/.well-known/openid-configuration", ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
            {
                steps.Add(new(TenantStep, false, Explain(ErrorOf(body) ?? $"Réponse {(int)response.StatusCode} de Microsoft.")));
                return new(false, null, steps);
            }
            tenantId = Property(body, "issuer") is { } issuer && GuidPattern().Match(issuer) is { Success: true } id ? id.Value : null;
            steps.Add(new(TenantStep, true, tenantId is null ? "Locataire trouvé." : $"Locataire trouvé (ID {tenantId})."));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            steps.Add(new(TenantStep, false, Unreachable(ex)));
            return new(false, null, steps);
        }

        // 2. L'application existe et le secret est le bon : jeton d'application (client credentials), aussitôt oublié.
        var client = clientId?.Trim();
        if (string.IsNullOrEmpty(client) || string.IsNullOrEmpty(secret))
        {
            steps.Add(new(ApplicationStep, null, string.IsNullOrEmpty(client)
                ? "Saisissez l'ID d'application (client) pour vérifier l'application."
                : "Saisissez le secret client pour vérifier l'application."));
            return new(false, tenantId, steps);
        }
        if (!Guid.TryParse(client, out _))
        {
            steps.Add(new(ApplicationStep, false, "L'ID d'application (client) est un GUID : copiez-le depuis la page « Vue d'ensemble » de l'inscription."));
            return new(false, tenantId, steps);
        }
        try
        {
            using var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "client_credentials",
                ["client_id"] = client,
                ["client_secret"] = secret,
                ["scope"] = "https://graph.microsoft.com/.default",
            });
            using var response = await http.PostAsync($"https://login.microsoftonline.com/{Uri.EscapeDataString(tenant!)}/oauth2/v2.0/token", form, ct);
            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(ct);
                steps.Add(new(ApplicationStep, false, Explain(ErrorOf(body) ?? $"Réponse {(int)response.StatusCode} de Microsoft.")));
                return new(false, tenantId, steps);
            }
            steps.Add(new(ApplicationStep, true, "Application trouvée, secret valide."));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            steps.Add(new(ApplicationStep, false, Unreachable(ex)));
            return new(false, tenantId, steps);
        }
        return new(true, tenantId, steps);
    }

    private static string Unreachable(Exception ex) => ex is TaskCanceledException
        ? "Microsoft n'a pas répondu à temps : vérifiez l'accès Internet du serveur Wolflog (proxy sortant, pare-feu)."
        : $"Impossible de joindre login.microsoftonline.com depuis le serveur Wolflog ({ex.Message}) : vérifiez son accès Internet (proxy sortant, pare-feu).";

    /// <summary>Description d'une erreur OAuth (error_description, sinon error), si la réponse en contient une.</summary>
    private static string? ErrorOf(string body) => Property(body, "error_description") ?? Property(body, "error");

    private static string? Property(string json, string name)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
