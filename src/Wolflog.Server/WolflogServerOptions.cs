namespace Wolflog.Server;

public sealed class WolflogServerOptions
{
    public const string Section = "Wolflog";

    /// <summary>Dossier des données (segments Parquet, WAL, secrets). Vide = "data" à côté du binaire.</summary>
    public string DataDirectory { get; set; } = "";

    public AuthOptions Auth { get; set; } = new();
    public StorageOptions Storage { get; set; } = new();
    public RetentionOptions Retention { get; set; } = new();

    public sealed class AuthOptions
    {
        /// <summary>false = aucune authentification (réservé au développement local).</summary>
        public bool Enabled { get; set; } = true;
        public string AdminUser { get; set; } = "admin";
        /// <summary>Vide = mot de passe généré au premier démarrage (voir secrets.json dans le dossier de données).</summary>
        public string AdminPassword { get; set; } = "";
        /// <summary>Clés acceptées pour l'ingestion. Vide = clé générée au premier démarrage.</summary>
        public List<string> ApiKeys { get; set; } = [];
        /// <summary>Connexion unique (OpenID Connect : Entra ID / Azure AD, Keycloak, Google…).</summary>
        public OidcOptions Oidc { get; set; } = new();
    }

    public sealed class OidcOptions
    {
        /// <summary>Ex. https://login.microsoftonline.com/&lt;tenant&gt;/v2.0. Vide = SSO désactivé.</summary>
        public string Authority { get; set; } = "";
        public string ClientId { get; set; } = "";
        public string ClientSecret { get; set; } = "";
        /// <summary>Texte du bouton de connexion.</summary>
        public string DisplayName { get; set; } = "Microsoft";
        /// <summary>Rôle donné aux nouveaux utilisateurs SSO (viewer, editor ou admin).</summary>
        public string DefaultRole { get; set; } = "viewer";
        /// <summary>Claim contenant les groupes / rôles de l'annuaire.</summary>
        public string GroupsClaim { get; set; } = "groups";
        public List<string> AdminGroups { get; set; } = [];
        public List<string> EditorGroups { get; set; } = [];
    }

    public sealed class StorageOptions
    {
        public int FlushIntervalSeconds { get; set; } = 60;
        public int FlushRows { get; set; } = 100_000;
        /// <summary>true = fsync du WAL à chaque lot (résiste aux coupures de courant, plus lent).</summary>
        public bool FsyncWal { get; set; }
        /// <summary>Limite mémoire DuckDB, ex: "2GB". Vide = 25 % de la RAM (entre 512 Mo et 4 Go).</summary>
        public string MemoryLimit { get; set; } = "";
        public int Threads { get; set; }
        /// <summary>Âge minimum (minutes) d'une partition horaire avant compaction.</summary>
        public int CompactionDelayMinutes { get; set; } = 5;
    }

    public sealed class RetentionOptions
    {
        public int LogsDays { get; set; } = 14;
        public int TracesDays { get; set; } = 7;
        public int MetricsDays { get; set; } = 30;
        /// <summary>0 = illimité. Sinon supprime les segments les plus anciens au-delà.</summary>
        public double MaxDiskGb { get; set; }
    }

    public string ResolveDataDirectory(string contentRoot)
    {
        var dir = string.IsNullOrWhiteSpace(DataDirectory) ? Path.Combine(contentRoot, "data") : DataDirectory;
        return Path.GetFullPath(dir);
    }
}
