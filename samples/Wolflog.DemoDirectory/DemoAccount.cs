namespace Wolflog.DemoDirectory;

/// <summary>Personne de l'annuaire de démonstration : identifiant (sAMAccountName), mot de passe fictif, groupes directs, état.</summary>
public sealed record DemoAccount(string Login, string Name, string Password, string[] Groups, bool Disabled = false, bool MustChangePassword = false);
