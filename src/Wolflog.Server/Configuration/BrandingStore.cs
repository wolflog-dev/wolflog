namespace Wolflog.Server.Configuration;

/// <summary>
/// Personnalisation (branding.json) et logo de l'entreprise (fichier branding-logo à côté), dans le dossier de données :
/// tous deux font partie des sauvegardes de la configuration et sont relus après une restauration.
/// </summary>
public sealed class BrandingStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<Branding>(o.Value.ResolveDataDirectory(env.ContentRootPath), "branding.json")
{
    public const string DocumentId = "branding";
    /// <summary>Fichier du logo dans le dossier de données (son type est dans branding.json).</summary>
    public const string LogoFile = "branding-logo";

    private readonly Lock _logo = new();

    public string LogoPath => Path.Combine(Path.GetDirectoryName(FilePath)!, LogoFile);

    public Branding Current => Get(DocumentId) ?? new Branding();

    /// <summary>Un logo est enregistré et son fichier est présent.</summary>
    public bool HasLogo(Branding branding) => branding.LogoVersion != null && File.Exists(LogoPath);

    /// <summary>Contenu du logo (null : aucun). Lecture partagée : un remplacement en cours ne la bloque pas.</summary>
    public byte[]? ReadLogo()
    {
        if (Current.LogoVersion is null) return null;
        try
        {
            using var file = new FileStream(LogoPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var buffer = new MemoryStream();
            file.CopyTo(buffer);
            return buffer.ToArray();
        }
        catch (FileNotFoundException) { return null; }
    }

    /// <summary>Modifie la personnalisation (document créé au premier enregistrement).</summary>
    public Branding Change(Action<Branding> change, string? by)
    {
        void Apply(Branding b)
        {
            change(b);
            b.UpdatedAt = DateTime.UtcNow;
            b.UpdatedBy = by;
        }
        if (Update(DocumentId, Apply) is { } updated) return updated;
        var created = new Branding();
        Apply(created);
        return Upsert(created);
    }

    /// <summary>Remplace le logo : le fichier est écrit (atomiquement) avant ses informations, jamais l'inverse.</summary>
    public Branding SetLogo(byte[] content, string contentType, string fileName, string? by)
    {
        lock (_logo)
        {
            var tmp = LogoPath + ".tmp";
            File.WriteAllBytes(tmp, content);
            File.Move(tmp, LogoPath, overwrite: true);
            return Change(b =>
            {
                b.LogoFileName = fileName;
                b.LogoContentType = contentType;
                b.LogoSize = content.Length;
                b.LogoVersion = BrandingLogo.Version(content);
            }, by);
        }
    }

    /// <summary>Retire le logo (sans effet s'il n'y en a pas).</summary>
    public Branding RemoveLogo(string? by)
    {
        lock (_logo)
        {
            var branding = Change(b =>
            {
                b.LogoFileName = b.LogoContentType = b.LogoVersion = null;
                b.LogoSize = 0;
            }, by);
            File.Delete(LogoPath);
            return branding;
        }
    }
}
