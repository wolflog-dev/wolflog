namespace Wolflog.Server.Security;

/// <summary>
/// Groupe de l'annuaire donnant un rôle et/ou un profil d'accès : ID d'objet d'un groupe Entra ID (revendication
/// « groups »), valeur d'un rôle d'application (« roles »), DOMAINE\groupe ou SID d'un groupe Windows.
/// </summary>
public sealed class SsoGroupMapping
{
    /// <summary>Valeur transmise par l'annuaire (comparée sans tenir compte de la casse).</summary>
    public string Group { get; set; } = "";
    /// <summary>Nom lisible (facultatif), ex. « Équipe support » pour un ID de groupe.</summary>
    public string? Name { get; set; }
    /// <summary>Rôle des membres (null = ce groupe ne donne pas de rôle).</summary>
    public string? Role { get; set; }
    /// <summary>Profil d'accès des membres (null = ce groupe ne donne pas de profil).</summary>
    public string? ProfileId { get; set; }
}
