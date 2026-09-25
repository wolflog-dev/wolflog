namespace Wolflog.Server.Monitoring;

/// <summary>Date de la dernière sauvegarde (fichier backup-state.txt du dossier de données).</summary>
public sealed class BackupState(IOptions<WolflogServerOptions> options, IHostEnvironment env)
{
    private readonly string _path = Path.Combine(options.Value.ResolveDataDirectory(env.ContentRootPath), "backup-state.txt");

    public DateTime? LastBackupAt =>
        File.Exists(_path) && DateTime.TryParse(File.ReadAllText(_path).Trim(), null, System.Globalization.DateTimeStyles.RoundtripKind, out var d) ? d : null;

    public void Mark() => File.WriteAllText(_path, DateTime.UtcNow.ToString("O"));

    public static void Mark(string dataDirectory) => File.WriteAllText(Path.Combine(dataDirectory, "backup-state.txt"), DateTime.UtcNow.ToString("O"));
}
