using Microsoft.Extensions.Options;
using Vigil.Server.Storage;

namespace Vigil.Server.Monitoring;

/// <summary>ok, warning ou critical.</summary>
public sealed record HealthCheck(string Id, string Name, string Status, string Message, double? Value = null);

public sealed record HealthReport(string Status, IReadOnlyList<HealthCheck> Checks, DateTime At);

/// <summary>Santé de Vigil lui-même : disque, écriture, réception, notifications, sauvegardes.</summary>
public sealed class HealthService(StorageHost storage, IOptions<VigilServerOptions> options, AlertChannelStore channels, BackupState backups)
{
    public HealthReport Check()
    {
        var o = options.Value;
        var checks = new List<HealthCheck>();

        // Espace disque du dossier de données.
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(storage.DataDirectory)!);
            var freeGb = drive.AvailableFreeSpace / 1024d / 1024 / 1024;
            var freePct = 100d * drive.AvailableFreeSpace / Math.Max(1, drive.TotalSize);
            var status = freePct < 3 || freeGb < 1 ? "critical" : freePct < 10 || freeGb < 5 ? "warning" : "ok";
            checks.Add(new HealthCheck("disk", "Espace disque", status, $"{N(freeGb)} Go libres ({freePct:0} %) sur {drive.Name}", freePct));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            checks.Add(new HealthCheck("disk", "Espace disque", "warning", "Espace disque illisible : " + ex.Message));
        }

        // Quota de rétention.
        var used = storage.DiskBytes() / 1024d / 1024 / 1024;
        if (o.Retention.MaxDiskGb > 0)
        {
            var pct = 100 * used / o.Retention.MaxDiskGb;
            checks.Add(new HealthCheck("quota", "Quota de stockage", pct > 95 ? "warning" : "ok",
                $"{N(used, "#,0.##")} Go utilisés sur {N(o.Retention.MaxDiskGb)} Go (les données les plus anciennes sont supprimées au-delà)", pct));
        }

        // Écriture : file d'attente et erreurs récentes.
        var backlog = storage.All.Sum(s => s.Backlog);
        checks.Add(new HealthCheck("backlog", "File d'écriture", backlog > 3500 ? "critical" : backlog > 1000 ? "warning" : "ok",
            backlog == 0 ? "Aucun retard d'écriture" : $"{backlog} lots en attente d'écriture", backlog));
        var lastError = storage.All.Where(s => s.LastErrorAt != null).OrderByDescending(s => s.LastErrorAt).FirstOrDefault();
        checks.Add(lastError?.LastErrorAt is { } errAt && DateTime.UtcNow - errAt < TimeSpan.FromMinutes(15)
            ? new HealthCheck("writes", "Écriture des données", "critical", $"{lastError.Name} : {lastError.LastError}")
            : new HealthCheck("writes", "Écriture des données", "ok", "Aucune erreur d'écriture récente"));

        // Réception.
        var lastIngest = storage.All.Max(s => s.LastIngestAt);
        var uptime = DateTime.UtcNow - storage.StartedAt;
        if (lastIngest is null)
            checks.Add(new HealthCheck("ingest", "Réception", uptime > TimeSpan.FromMinutes(10) ? "warning" : "ok",
                "Aucune donnée reçue depuis le démarrage"));
        else
        {
            var idle = DateTime.UtcNow - lastIngest.Value;
            checks.Add(new HealthCheck("ingest", "Réception", idle > TimeSpan.FromMinutes(15) ? "warning" : "ok",
                idle < TimeSpan.FromMinutes(1) ? "Données reçues à l'instant" : $"Dernières données reçues il y a {Human(idle)}", idle.TotalSeconds));
        }

        // Canaux de notification.
        var failing = channels.All().Where(c => c.LastErrorAt != null && (c.LastSentAt is null || c.LastErrorAt > c.LastSentAt)).ToList();
        checks.Add(failing.Count > 0
            ? new HealthCheck("notifications", "Notifications", "warning", $"Échec d'envoi : {string.Join(", ", failing.Select(c => $"{c.Name} ({c.LastError})"))}")
            : new HealthCheck("notifications", "Notifications", "ok", channels.All().Count == 0 ? "Aucun canal configuré" : "Derniers envois réussis"));

        // Sauvegardes.
        checks.Add(backups.LastBackupAt is { } last
            ? new HealthCheck("backup", "Sauvegarde", DateTime.UtcNow - last > TimeSpan.FromDays(8) ? "warning" : "ok", $"Dernière sauvegarde il y a {Human(DateTime.UtcNow - last)}")
            : new HealthCheck("backup", "Sauvegarde", "ok", "Aucune sauvegarde réalisée depuis cette interface ou la commande vigil backup"));

        var overall = checks.Any(c => c.Status == "critical") ? "critical" : checks.Any(c => c.Status == "warning") ? "warning" : "ok";
        return new HealthReport(overall, checks, DateTime.UtcNow);
    }

    private static string N(double v, string format = "#,0.#") => v.ToString(format, Configuration.French.Numbers);

    public static string Human(TimeSpan t) =>
        t.TotalDays >= 1 ? $"{(int)t.TotalDays} j" : t.TotalHours >= 1 ? $"{(int)t.TotalHours} h" : $"{Math.Max(1, (int)t.TotalMinutes)} min";
}

/// <summary>Date de la dernière sauvegarde (fichier backup-state.txt du dossier de données).</summary>
public sealed class BackupState(IOptions<VigilServerOptions> options, IHostEnvironment env)
{
    private readonly string _path = Path.Combine(options.Value.ResolveDataDirectory(env.ContentRootPath), "backup-state.txt");

    public DateTime? LastBackupAt =>
        File.Exists(_path) && DateTime.TryParse(File.ReadAllText(_path).Trim(), null, System.Globalization.DateTimeStyles.RoundtripKind, out var d) ? d : null;

    public void Mark() => File.WriteAllText(_path, DateTime.UtcNow.ToString("O"));

    public static void Mark(string dataDirectory) => File.WriteAllText(Path.Combine(dataDirectory, "backup-state.txt"), DateTime.UtcNow.ToString("O"));
}
