using Microsoft.Extensions.Options;
using Vigil.Server.Configuration;
using Vigil.Server.Query;

namespace Vigil.Server.Monitoring;

/// <summary>
/// Objectif de service : part minimale d'événements « bons » sur une fenêtre glissante
/// (ex. 99,9 % des requêtes sans erreur serveur sur 30 jours).
/// </summary>
public sealed class Slo : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>availability (sans erreur) ou latency (plus rapide que LatencyMs).</summary>
    public string Kind { get; set; } = "availability";
    /// <summary>http (requêtes entrantes d'un service) ou probe (résultats d'une sonde).</summary>
    public string Source { get; set; } = "http";
    public string? Service { get; set; }
    /// <summary>Filtre sur la route ou le chemin (facultatif).</summary>
    public string? Route { get; set; }
    public string? ProbeId { get; set; }
    public double TargetPercent { get; set; } = 99.9;
    public double LatencyMs { get; set; } = 500;
    public int WindowDays { get; set; } = 30;
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class SloStore(IOptions<VigilServerOptions> o, IHostEnvironment env)
    : JsonCollection<Slo>(o.Value.ResolveDataDirectory(env.ContentRootPath), "slos.json");

public sealed record SloStatus(
    string Id, long Total, long Bad, double? Sli, double TargetPercent,
    /// <summary>Part du budget d'erreur restante (100 = intact, négatif = dépassé).</summary>
    double? BudgetRemaining,
    double? BurnRate1h, double? BurnRate6h,
    /// <summary>ok, warning (budget &lt; 25 % ou consommation rapide), breached (objectif non tenu).</summary>
    string State);

public sealed record SloPoint(DateTime T, double? Sli, double? BudgetRemaining);

public static class SloCalculator
{
    public static (long Total, long Bad) Count(QueryService qs, Slo slo, DateTime from, DateTime to, CancellationToken ct) =>
        slo.Source == "probe"
            ? qs.ProbeGoodBad(slo.ProbeId ?? "", from, to, ct)
            : qs.HttpGoodBad(from, to, Filter(slo), slo.Kind == "latency" ? slo.LatencyMs : null, ct);

    public static HttpFilter Filter(Slo slo) => new(slo.Service, slo.Route, null, null, false);

    public static SloStatus Status(QueryService qs, Slo slo, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var (total, bad) = Count(qs, slo, now.AddDays(-Math.Clamp(slo.WindowDays, 1, 90)), now, ct);
        var allowed = 1 - slo.TargetPercent / 100;
        double? sli = total == 0 ? null : 100.0 * (total - bad) / total;
        double? remaining = total == 0 || allowed <= 0 ? null : 100.0 * (1 - bad / (allowed * total));
        double? Burn(int hours)
        {
            var (t, b) = Count(qs, slo, now.AddHours(-hours), now, ct);
            return t == 0 || allowed <= 0 ? null : (double)b / t / allowed;
        }
        var burn1 = Burn(1);
        var burn6 = Burn(6);
        var state = sli is { } s && s < slo.TargetPercent ? "breached"
            : remaining is < 25 || burn1 is > 14.4 || burn6 is > 6 ? "warning"
            : "ok";
        return new SloStatus(slo.Id, total, bad, sli, slo.TargetPercent, remaining, burn1, burn6, state);
    }

    /// <summary>
    /// Évolution du SLI et du budget restant (cumulés depuis le début de la fenêtre).
    /// Le pas s'adapte à la période réellement couverte : un objectif récent reste lisible.
    /// </summary>
    public static IReadOnlyList<SloPoint> History(QueryService qs, Slo slo, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var from = now.AddDays(-Math.Clamp(slo.WindowDays, 1, 90));
        var coarse = Series(qs, slo, from, now, 3600, ct);
        var first = coarse.FirstOrDefault(p => p.Total > 0);
        if (first is null) return [];
        var start = first.T > from ? first.T : from;
        var step = (int)Math.Clamp((now - start).TotalSeconds / 120, 60, 86400);
        var points = step == 3600 ? coarse.SkipWhile(p => p.Total == 0).ToList() : Series(qs, slo, start, now, step, ct);

        var allowed = 1 - slo.TargetPercent / 100;
        long total = 0, bad = 0;
        var list = new List<SloPoint>(points.Count);
        foreach (var p in points)
        {
            total += p.Total;
            bad += p.Bad;
            list.Add(new SloPoint(p.T,
                p.Total == 0 ? null : 100.0 * (p.Total - p.Bad) / p.Total,
                total == 0 || allowed <= 0 ? null : 100.0 * (1 - bad / (allowed * total))));
        }
        return list;
    }

    private static IReadOnlyList<GoodBadPoint> Series(QueryService qs, Slo slo, DateTime from, DateTime to, int step, CancellationToken ct) =>
        slo.Source == "probe"
            ? qs.ProbeGoodBadSeries(slo.ProbeId ?? "", from, to, step, ct)
            : qs.HttpGoodBadSeries(from, to, Filter(slo), slo.Kind == "latency" ? slo.LatencyMs : null, step, ct);
}
