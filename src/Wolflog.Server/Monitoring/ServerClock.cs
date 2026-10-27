namespace Wolflog.Server.Monitoring;

/// <summary>
/// Heure de Wolflog, pour les plages d'activité des alertes et les heures fixes des sondes : fuseau configuré
/// (Wolflog:TimeZone), sinon celui du serveur.
/// </summary>
public sealed class ServerClock(TimeZoneInfo zone)
{
    public TimeZoneInfo Zone { get; } = zone;

    /// <summary>Fuseau configuré s'il existe sur cette machine, sinon celui du serveur (avec un avertissement).</summary>
    public static ServerClock From(string? configured, ILogger log)
    {
        if (string.IsNullOrWhiteSpace(configured)) return new ServerClock(TimeZoneInfo.Local);
        if (TimeZoneInfo.TryFindSystemTimeZoneById(configured.Trim(), out var zone)) return new ServerClock(zone);
        log.LogWarning("Fuseau horaire {Zone} inconnu sur ce serveur (sous Windows : « Romance Standard Time », sous Linux : « Europe/Paris ») : heure du serveur utilisée", configured);
        return new ServerClock(TimeZoneInfo.Local);
    }

    public DateTime ToLocal(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Zone);

    /// <summary>Heure locale en UTC ; une heure qui n'existe pas (passage à l'heure d'été) est décalée d'une heure.</summary>
    public DateTime ToUtc(DateTime local)
    {
        local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
        if (Zone.IsInvalidTime(local)) local = local.AddHours(1);
        return TimeZoneInfo.ConvertTimeToUtc(local, Zone);
    }

    /// <summary>Décalage actuel par rapport à UTC, en minutes.</summary>
    public int OffsetMinutes(DateTime utc) => (int)Zone.GetUtcOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).TotalMinutes;
}
