namespace Wolflog.Server.Security;

/// <summary>
/// Formulaire de connexion : compte Wolflog local d'abord (toujours possible, dont l'administrateur de secours), sinon
/// l'annuaire LDAP / Active Directory s'il est activé. Un compte de l'annuaire ne prend jamais la place d'un compte local.
/// </summary>
public sealed class PasswordSignIn(AuthService auth, SsoSettingsStore store, LdapDirectory directory, ILogger<PasswordSignIn> log)
{
    /// <summary>Compte connecté, ou statut HTTP et message pour la page de connexion.</summary>
    public sealed record Result(User? User, int Status, string? Error);

    public const string WrongCredentials = "Identifiant ou mot de passe incorrect.";

    public async Task<Result> SignInAsync(string? username, string? password, CancellationToken ct)
    {
        var name = username?.Trim() ?? "";
        // Mot de passe vide refusé d'emblée : pour un annuaire, ce serait une liaison anonyme… réussie.
        if (name.Length == 0 || string.IsNullOrEmpty(password)) return Denied();

        // Compte local avec mot de passe (dont l'administrateur de secours) : jamais l'annuaire pour ce nom.
        var local = auth.Users.ByUsername(name);
        var ldap = store.Current.Ldap;
        if ((local is { Source: "local" } && !string.IsNullOrEmpty(local.PasswordHash)) || !ldap.Enabled || !ldap.IsComplete())
            return auth.ValidateUser(name, password) is { } user ? new(user, StatusCodes.Status200OK, null) : Denied();

        var outcome = await directory.AuthenticateAsync(ldap, store.BindPassword(ldap), name, password, ct);
        if (outcome.Account is not { } account)
        {
            // Saisie erronée : simple information. Panne ou configuration : visible dans Administration > Connexion SSO.
            if (outcome.Failure is LdapDirectory.Unavailable or LdapDirectory.Misconfigured) store.RecordFailure("ldap", $"{name} : {outcome.Detail}.");
            else log.LogInformation("Connexion par l'annuaire refusée pour {User} : {Detail}", name, outcome.Detail);
            return outcome.Failure switch
            {
                LdapDirectory.PasswordChange => new(null, StatusCodes.Status401Unauthorized,
                    "Votre mot de passe a expiré ou doit être changé : changez-le depuis votre poste Windows, puis reconnectez-vous."),
                LdapDirectory.Locked => new(null, StatusCodes.Status401Unauthorized,
                    "Compte verrouillé dans l'annuaire après trop d'essais : réessayez plus tard ou contactez le support."),
                LdapDirectory.Unavailable => new(null, StatusCodes.Status503ServiceUnavailable,
                    "Annuaire de l'entreprise injoignable pour le moment : réessayez plus tard, ou utilisez un compte Wolflog."),
                // Réglages à revoir (compte de service refusé, DN de base…) : réessayer n'y changerait rien.
                LdapDirectory.Misconfigured => new(null, StatusCodes.Status503ServiceUnavailable,
                    "Connexion par l'annuaire de l'entreprise impossible : un administrateur doit vérifier ses réglages. Un compte Wolflog reste utilisable."),
                _ => Denied(),
            };
        }

        var result = SsoProvisioning.Provision(auth.Users, Identity(account), store.Current.Rules());
        if (result.User is null)
        {
            store.RecordFailure("ldap", $"{account.Username} : {SsoProvisioning.Explain(result.Refusal)}.");
            return new(null, StatusCodes.Status403Forbidden, result.Refusal switch
            {
                SsoProvisioning.Disabled => "Ce compte est désactivé dans Wolflog : contactez un administrateur.",
                SsoProvisioning.Conflict => "Un compte Wolflog local porte déjà ce nom : un administrateur doit le renommer ou le supprimer.",
                _ => "Connexion refusée par les règles de Wolflog : contactez un administrateur.",
            });
        }
        return new(result.User, StatusCodes.Status200OK, null);
    }

    /// <summary>Identité Wolflog d'un compte de l'annuaire : chaque groupe par son DN et par son nom court (Wolflog-Admins).</summary>
    public static DirectoryIdentity Identity(LdapDirectory.Account account) => new("ldap", account.Username, account.DisplayName, account.Email,
        account.GroupDns.SelectMany(dn => new[] { dn, LdapDirectory.CommonName(dn) }).Where(group => group.Length > 0)
            .ToHashSet(StringComparer.OrdinalIgnoreCase));

    private static Result Denied() => new(null, StatusCodes.Status401Unauthorized, WrongCredentials);
}
