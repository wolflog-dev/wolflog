namespace Wolflog.Server.Security;

/// <summary>Étape d'une vérification (inscription Microsoft, annuaire LDAP) : réussie, en échec, ou sans objet (Ok = null).</summary>
public sealed record CheckStep(string Title, bool? Ok, string Message);
