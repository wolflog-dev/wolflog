namespace Vigil.Server;

public sealed class VigilServerOptions
{
    public const string Section = "Vigil";

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
    }

    public sealed class StorageOptions
    {
        public int FlushIntervalSeconds { get; set; } = 60;
        public int FlushRows { get; set; } = 100_000;
        /// <summary>true = fsync du WAL à chaque lot (résiste aux coupures de courant, plus lent).</summary>
        public bool FsyncWal { get; set; }
        /// <summary>Limite mémoire DuckDB, ex: "2GB". Vide = défaut DuckDB (80% de la RAM).</summary>
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
