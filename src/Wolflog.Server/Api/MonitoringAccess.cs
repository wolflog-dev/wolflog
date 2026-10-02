namespace Wolflog.Server.Api;

/// <summary>
/// Alertes, sondes et objectifs vus par un compte limité à certains services (profil d'accès) :
/// <list type="bullet">
/// <item>sonde : visible si elle n'est rattachée à aucun service (infrastructure commune) ou à un service visible ;</item>
/// <item>objectif (SLO) : celui d'un service visible, ou d'une sonde visible ;</item>
/// <item>règle d'alerte : celle d'un service visible ; une règle globale ne montre que ses éléments qui relèvent d'un service
/// visible (par service, erreurs, silences, sondes, objectifs) — un total tous services confondus reste caché ; la santé de
/// Wolflog lui-même reste visible.</item>
/// </list>
/// Écriture (créer, modifier, tester, couper, supprimer) : seulement sur un service visible, ou sur une sonde / un objectif
/// rattaché à un service visible. Sans limite de services : tout.
/// </summary>
public sealed class MonitoringAccess(ServiceScope scope, ProbeStore probeStore, SloStore sloStore)
{
    private Dictionary<string, Probe>? _probes;
    private Dictionary<string, Slo>? _slos;

    public static MonitoringAccess For(HttpContext ctx) => new(ctx.VisibleServices,
        ctx.RequestServices.GetRequiredService<ProbeStore>(), ctx.RequestServices.GetRequiredService<SloStore>());

    public bool Unrestricted => scope.IsAll;

    /// <summary>Refus d'une écriture hors des services visibles.</summary>
    public static IResult Forbidden() => Results.Json(
        new { error = "Hors de vos services : choisissez l'un des services que vous voyez (ou une sonde, un objectif qui en relève)." },
        statusCode: StatusCodes.Status403Forbidden);

    private Dictionary<string, Probe> Probes => _probes ??= probeStore.All().ToDictionary(p => p.Id);
    private Dictionary<string, Slo> Slos => _slos ??= sloStore.All().ToDictionary(s => s.Id);

    public bool Probe(Probe p) => scope.IsAll || string.IsNullOrEmpty(p.Service) || scope.Allows(p.Service);

    public bool ProbeWritable(Probe p) => scope.IsAll || (!string.IsNullOrWhiteSpace(p.Service) && scope.Allows(p.Service.Trim()));

    public bool Slo(Slo s) => scope.IsAll || (s.Source == "probe"
        ? s.ProbeId is { } id && Probes.TryGetValue(id, out var p) && Probe(p)
        : !string.IsNullOrEmpty(s.Service) && scope.Allows(s.Service));

    public bool SloWritable(Slo s) => scope.IsAll || (s.Source == "probe"
        ? s.ProbeId is { } id && Probes.TryGetValue(id, out var p) && ProbeWritable(p)
        : !string.IsNullOrWhiteSpace(s.Service) && scope.Allows(s.Service.Trim()));

    /// <summary>Règle montrée dans la liste (avec ses seuls éléments visibles, voir <see cref="State"/>).</summary>
    public bool Rule(AlertRule r)
    {
        if (scope.IsAll) return true;
        if (!string.IsNullOrEmpty(r.Service)) return scope.Allows(r.Service);
        return r.Kind switch
        {
            AlertKinds.Health => true,
            AlertKinds.Probe => string.IsNullOrEmpty(r.TargetId) || (Probes.TryGetValue(r.TargetId, out var p) && Probe(p)),
            AlertKinds.Slo => string.IsNullOrEmpty(r.TargetId) || (Slos.TryGetValue(r.TargetId, out var s) && Slo(s)),
            AlertKinds.Http => r.PerService,
            AlertKinds.Error or AlertKinds.Silence => true,
            AlertKinds.Query => IsServiceGroup(r),
            _ => false,
        };
    }

    /// <summary>
    /// Élément d'une règle (état en cours ou événement de l'historique) visible : sa clé, ou le service qu'il concerne
    /// (<paramref name="service"/> : variable « service » de l'évaluation), doit relever d'un service visible.
    /// </summary>
    public bool State(AlertRule r, string key, string? service)
    {
        if (scope.IsAll) return true;
        if (!string.IsNullOrEmpty(r.Service)) return scope.Allows(r.Service);
        return r.Kind switch
        {
            AlertKinds.Health => true,
            AlertKinds.Probe => Probes.TryGetValue(key, out var p) && Probe(p),
            AlertKinds.Slo => Slos.TryGetValue(key, out var s) && Slo(s),
            AlertKinds.Http or AlertKinds.Silence => key != "total" && scope.Allows(key),
            AlertKinds.Error => scope.Allows(service),
            AlertKinds.Query => IsServiceGroup(r) && scope.Allows(key),
            _ => false,
        };
    }

    /// <summary>Règle que le compte peut créer, modifier, tester ou couper : elle ne porte que sur ce qu'il voit.</summary>
    public bool RuleWritable(AlertRule r)
    {
        if (scope.IsAll) return true;
        if (!string.IsNullOrWhiteSpace(r.Service)) return scope.Allows(r.Service.Trim());
        return r.Kind switch
        {
            AlertKinds.Probe => !string.IsNullOrEmpty(r.TargetId) && Probes.TryGetValue(r.TargetId, out var p) && ProbeWritable(p),
            AlertKinds.Slo => !string.IsNullOrEmpty(r.TargetId) && Slos.TryGetValue(r.TargetId, out var s) && SloWritable(s),
            _ => false,
        };
    }

    private static bool IsServiceGroup(AlertRule r) =>
        string.Equals(r.GroupBy?.Trim(), "service", StringComparison.OrdinalIgnoreCase);
}
