namespace Wolflog.Server.Monitoring;

/// <summary>
/// Jours et heures, à l'heure de Wolflog : plages d'activité des alertes, heures fixes des sondes.
/// Jours : 0 = dimanche … 6 = samedi (comme <see cref="DayOfWeek"/>) ; aucun jour = tous les jours.
/// </summary>
public static class WeeklyHours
{
    /// <summary>Heure « HH:mm » (00:00 à 23:59).</summary>
    public static bool TryParseTime(string? value, out TimeSpan time)
    {
        time = default;
        if (string.IsNullOrWhiteSpace(value) || value.Trim().Split(':') is not [var h, var m]) return false;
        if (!int.TryParse(h, out var hours) || !int.TryParse(m, out var minutes) || hours is < 0 or > 23 || minutes is < 0 or > 59) return false;
        time = new TimeSpan(hours, minutes, 0);
        return true;
    }

    /// <summary>« H:mm » ou « HH:mm » ramené à « HH:mm » ; null si invalide.</summary>
    public static string? Normalize(string? value) => TryParseTime(value, out var t) ? $"{t.Hours:00}:{t.Minutes:00}" : null;

    private static bool Day(IReadOnlyCollection<int>? days, DayOfWeek day) => days is not { Count: > 0 } || days.Contains((int)day);

    /// <summary>
    /// L'instant (heure locale) est-il dans la plage ? De <paramref name="from"/> (inclus) à <paramref name="to"/> (exclu),
    /// les jours cochés ; une plage qui passe minuit (22:00 → 06:00) appartient au jour où elle commence. Sans heures :
    /// toute la journée.
    /// </summary>
    public static bool IsActive(IReadOnlyCollection<int>? days, string? from, string? to, DateTime local)
    {
        var hasFrom = TryParseTime(from, out var start);
        var hasTo = TryParseTime(to, out var end);
        if ((!hasFrom && !hasTo) || (hasFrom && hasTo && start == end)) return Day(days, local.DayOfWeek);
        if (!hasFrom) start = TimeSpan.Zero;
        if (!hasTo) end = TimeSpan.FromDays(1);
        var time = local.TimeOfDay;
        if (start < end) return Day(days, local.DayOfWeek) && time >= start && time < end;
        // Passe minuit : le soir du jour coché, ou le matin du lendemain.
        return time >= start ? Day(days, local.DayOfWeek) : time < end && Day(days, local.AddDays(-1).DayOfWeek);
    }

    /// <summary>Prochaine heure fixe (heure locale) strictement après <paramref name="local"/>, ou null s'il n'y en a pas.</summary>
    public static DateTime? Next(IReadOnlyCollection<string>? times, IReadOnlyCollection<int>? days, DateTime local)
    {
        var parsed = (times ?? []).Select(t => TryParseTime(t, out var v) ? v : (TimeSpan?)null).OfType<TimeSpan>().Distinct().Order().ToList();
        if (parsed.Count == 0) return null;
        for (var d = 0; d <= 7; d++)
        {
            var date = local.Date.AddDays(d);
            if (!Day(days, date.DayOfWeek)) continue;
            foreach (var t in parsed)
                if (date + t > local) return date + t;
        }
        return null;
    }
}
