namespace Wolflog.Server.Configuration;

/// <summary>
/// Personnalisation aux couleurs d'une entreprise (un seul document, id "branding") : nom, couleur, message de la page
/// de connexion et informations du logo. Le logo lui-même est un fichier à part (voir <see cref="BrandingStore"/>).
/// </summary>
public sealed class Branding : IEntity
{
    public string Id { get; set; } = BrandingStore.DocumentId;
    /// <summary>Nom de l'entreprise : remplace « Wolflog » dans le menu, les titres et la page de connexion. null = Wolflog.</summary>
    public string? CompanyName { get; set; }
    /// <summary>Couleur de l'entreprise (#rrggbb) : l'interface en tire la palette « Entreprise ». null = palettes intégrées.</summary>
    public string? Color { get; set; }
    /// <summary>Message d'accueil de la page de connexion (texte simple, retours à la ligne conservés).</summary>
    public string? LoginMessage { get; set; }
    /// <summary>true = palette de l'entreprise pour tous, sans choix dans le menu (sinon proposée par défaut).</summary>
    public bool ForcePalette { get; set; }
    /// <summary>Nom du fichier envoyé (affichage seulement).</summary>
    public string? LogoFileName { get; set; }
    /// <summary>image/png, image/jpeg, image/webp ou image/svg+xml, reconnu au contenu du fichier.</summary>
    public string? LogoContentType { get; set; }
    public long LogoSize { get; set; }
    /// <summary>Empreinte du contenu : version de l'adresse du logo (/api/branding/logo?v=…), mise en cache sans limite.</summary>
    public string? LogoVersion { get; set; }
    public DateTime? UpdatedAt { get; set; }
    public string? UpdatedBy { get; set; }
}
