namespace Wolflog.Server.Security;

/// <summary>
/// Accès du compte connecté pour la requête en cours : posé par le filtre de l'API (AccessEndpoints) pour les comptes
/// limités ; tout par défaut (administrateur, compte sans limite, authentification désactivée, route anonyme).
/// </summary>
public static class RequestAccess
{
    private const string Key = "wolflog.access";

    extension(HttpContext ctx)
    {
        /// <summary>Parties et services visibles du compte connecté.</summary>
        public AccessGrant Access => ctx.Items.TryGetValue(Key, out var value) && value is AccessGrant grant ? grant : AccessGrant.Full;

        /// <summary>Services visibles du compte connecté (tous par défaut).</summary>
        public ServiceScope VisibleServices => ctx.Access.Services;

        public void SetAccess(AccessGrant grant) => ctx.Items[Key] = grant;
    }
}
