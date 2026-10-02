using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Wolflog.Tests;

/// <summary>
/// login.microsoftonline.com simulé : un locataire, une application et son secret (réponses et erreurs AADSTS réalistes),
/// et des jetons d'identité signés pour rejouer une connexion complète (code + PKCE).
/// </summary>
public sealed class FakeEntraHandler : HttpMessageHandler
{
    public const string Tenant = "contoso.onmicrosoft.com";
    public const string TenantId = "0b8f6c2e-3d4a-4f1b-9e7c-5a6d7e8f9a0b";
    public const string ClientId = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
    public const string Secret = "Valeur~du-secret.42";

    private static readonly RsaSecurityKey SigningKey = new(RSA.Create(2048)) { KeyId = "cle-de-test" };

    /// <summary>Personne qui « se connecte » : revendications du prochain jeton d'identité (preferred_username, name, groups…).</summary>
    public Dictionary<string, object> NextIdentity { get; set; } = [];

    /// <summary>Nonce de la demande d'autorisation, à reprendre dans le jeton d'identité.</summary>
    public string? Nonce { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var path = request.RequestUri!.AbsolutePath;
        var tenant = path.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (tenant != Tenant && tenant != TenantId)
            return Json(HttpStatusCode.BadRequest, new
            {
                error = "invalid_tenant",
                error_description = $"AADSTS90002: Tenant '{tenant}' not found. Check to make sure you have the correct tenant ID.\r\nTrace ID: 42",
                error_codes = new[] { 90002 },
            });

        var authority = $"https://login.microsoftonline.com/{TenantId}";
        if (path.EndsWith("/.well-known/openid-configuration", StringComparison.Ordinal))
            return Json(HttpStatusCode.OK, new
            {
                issuer = authority + "/v2.0",
                authorization_endpoint = authority + "/oauth2/v2.0/authorize",
                token_endpoint = authority + "/oauth2/v2.0/token",
                jwks_uri = authority + "/discovery/v2.0/keys",
                end_session_endpoint = authority + "/oauth2/v2.0/logout",
                response_types_supported = new[] { "code", "id_token", "code id_token" },
                response_modes_supported = new[] { "query", "fragment", "form_post" },
                scopes_supported = new[] { "openid", "profile", "email" },
                id_token_signing_alg_values_supported = new[] { "RS256" },
            });
        if (path.EndsWith("/discovery/v2.0/keys", StringComparison.Ordinal))
        {
            var key = SigningKey.Rsa.ExportParameters(false);
            return Json(HttpStatusCode.OK, new
            {
                keys = new[] { new { kty = "RSA", use = "sig", alg = "RS256", kid = SigningKey.KeyId, n = Base64UrlEncoder.Encode(key.Modulus), e = Base64UrlEncoder.Encode(key.Exponent) } },
            });
        }
        if (path.EndsWith("/oauth2/v2.0/token", StringComparison.Ordinal))
        {
            var form = QueryHelpers.ParseQuery(await request.Content!.ReadAsStringAsync(ct));
            if (form["client_id"] != ClientId)
                return Json(HttpStatusCode.BadRequest, new
                {
                    error = "unauthorized_client",
                    error_description = $"AADSTS700016: Application with identifier '{form["client_id"]}' was not found in the directory 'Contoso'.",
                    error_codes = new[] { 700016 },
                });
            if (form["client_secret"] != Secret)
                return Json(HttpStatusCode.Unauthorized, new
                {
                    error = "invalid_client",
                    error_description = "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.",
                    error_codes = new[] { 7000215 },
                });
            const string accessToken = "jeton-d-acces-de-test";
            if (form["grant_type"] != "authorization_code")
                return Json(HttpStatusCode.OK, new { token_type = "Bearer", expires_in = 3599, access_token = accessToken });
            return Json(HttpStatusCode.OK, new { token_type = "Bearer", expires_in = 3599, access_token = accessToken, id_token = IdToken(accessToken, authority) });
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    /// <summary>Jeton d'identité signé, comme Entra ID le délivre en échange du code d'autorisation.</summary>
    private string IdToken(string accessToken, string authority)
    {
        var claims = new Dictionary<string, object>(NextIdentity)
        {
            ["nonce"] = Nonce ?? "",
            ["tid"] = TenantId,
            ["sub"] = "sujet-" + NextIdentity.GetValueOrDefault("preferred_username"),
            // at_hash : moitié gauche du SHA-256 du jeton d'accès (RS256).
            ["at_hash"] = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(accessToken))[..16]),
        };
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = authority + "/v2.0",
            Audience = ClientId,
            IssuedAt = DateTime.UtcNow,
            NotBefore = DateTime.UtcNow.AddMinutes(-1),
            Expires = DateTime.UtcNow.AddMinutes(10),
            Claims = claims,
            SigningCredentials = new SigningCredentials(SigningKey, SecurityAlgorithms.RsaSha256),
        });
    }

    private static HttpResponseMessage Json(HttpStatusCode status, object body) => new(status) { Content = JsonContent.Create(body) };
}
