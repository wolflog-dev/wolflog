using Microsoft.AspNetCore.WebUtilities;

namespace Wolflog.Tests;

/// <summary>
/// login.microsoftonline.com simulé pour les messageries : connexion par code (en attente, puis acceptée), renouvellement
/// (l'ancien jeton de renouvellement devient invalide, plus strict que Microsoft) et jeton d'application. Chaque jeton
/// d'accès délivré est accepté par le faux serveur de messagerie.
/// </summary>
public sealed class FakeMicrosoftMail(FakeMailServer mail) : HttpMessageHandler
{
    public const string Tenant = "exemple.test";
    public const string ClientId = "11111111-2222-4333-8444-555555555555";
    public const string Secret = "secret~de~test";

    /// <summary>Interrogations restantes avant que le code soit « saisi ».</summary>
    public int PendingPolls { get; set; } = 1;
    public List<string> Grants { get; } = [];
    private string _refresh = "";
    private int _issued;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var path = request.RequestUri!.AbsolutePath;
        var form = QueryHelpers.ParseQuery(await request.Content!.ReadAsStringAsync(ct));
        if (form["client_id"] != ClientId)
            return Json(HttpStatusCode.BadRequest, "unauthorized_client", "AADSTS700016: Application with identifier 'x' was not found in the directory 'Exemple'.");
        if (path.EndsWith("/oauth2/v2.0/devicecode", StringComparison.Ordinal))
            return Json(HttpStatusCode.OK, new { device_code = "code-appareil", user_code = "ABCD-EFGH", verification_uri = "https://microsoft.com/devicelogin", expires_in = 900, interval = 0 });

        var grant = form["grant_type"].ToString();
        Grants.Add(grant);
        switch (grant)
        {
            case "urn:ietf:params:oauth:grant-type:device_code":
                if (PendingPolls-- > 0) return Json(HttpStatusCode.BadRequest, "authorization_pending", "AADSTS70016: OAuth 2.0 device flow error. Authorization is pending.");
                return Tokens(account: true);
            case "refresh_token":
                if (form["refresh_token"] != _refresh)
                    return Json(HttpStatusCode.BadRequest, "invalid_grant", "AADSTS70000: Provided grant is invalid or malformed.");
                return Tokens(account: true);
            case "client_credentials":
                if (form["client_secret"] != Secret)
                    return Json(HttpStatusCode.Unauthorized, "invalid_client", "AADSTS7000215: Invalid client secret provided.");
                return Tokens(account: false);
            default:
                return Json(HttpStatusCode.BadRequest, "unsupported_grant_type", "AADSTS70003: unsupported grant");
        }
    }

    private HttpResponseMessage Tokens(bool account)
    {
        var access = $"jeton-{Interlocked.Increment(ref _issued)}";
        lock (mail.Tokens) mail.Tokens.Add(access);
        if (!account) return Json(HttpStatusCode.OK, new { token_type = "Bearer", expires_in = 3599, access_token = access });
        _refresh = $"renouvellement-{_issued}";
        var payload = Base64Url(JsonSerializer.Serialize(new { preferred_username = FakeMailServer.User, name = "Sonde" }));
        return Json(HttpStatusCode.OK, new { token_type = "Bearer", expires_in = 3599, access_token = access, refresh_token = _refresh, id_token = $"e30.{payload}.signature" });
    }

    private static string Base64Url(string s) => Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static HttpResponseMessage Json(HttpStatusCode status, string error, string description) =>
        Json(status, new { error, error_description = description + "\r\nTrace ID: 42" });

    private static HttpResponseMessage Json(HttpStatusCode status, object body) => new(status) { Content = JsonContent.Create(body) };
}
