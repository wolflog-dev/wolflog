using System.Globalization;
using Microsoft.Extensions.Options;
using Vigil.Server.Configuration;
using Vigil.Server.Query;
using Vigil.Server.Storage;

namespace Vigil.Server.Monitoring;

/// <summary>Résultat de l'évaluation d'une règle pour une clé (total, un service, une erreur…).</summary>
public sealed record AlertEvaluation(string Key, bool Breach, double? Value, string Message, string? Link, bool IsEvent = false);

/// <summary>
/// Évalue les règles toutes les 30 secondes : ok → en attente (si une durée est demandée) → active → résolue.
/// Notifie à l'activation, à la résolution et, si demandé, en rappel tant que l'alerte reste active.
/// </summary>
public sealed class AlertEngine(
    AlertRuleStore rules, AlertStateStore stateStore, AlertEventStore events, Notifier notifier,
    StorageHost storage, ErrorStateStore errorStates, ProbeEngine probes, ProbeStore probeStore, SloStore slos, HealthService health,
    IOptions<VigilServerOptions> options, ILogger<AlertEngine> log) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private static readonly NumberFormatInfo Fr = French.Numbers;

    private readonly Lock _lock = new();
    private Dictionary<string, AlertState> _states = [];
    private HashSet<string>? _knownErrors;
    public DateTime? LastRunAt { get; private set; }

    public IReadOnlyList<AlertState> States()
    {
        lock (_lock) return _states.Values.Select(Copy).ToList();
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        lock (_lock) _states = stateStore.All().ToDictionary(s => s.Id);
        await Task.Delay(TimeSpan.FromSeconds(10), stop);
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try { await RunOnceAsync(stop); }
            catch (Exception ex) when (!stop.IsCancellationRequested) { log.LogError(ex, "Évaluation des alertes"); }
        }
        while (await timer.WaitForNextTickAsync(stop));
    }

    public async Task RunOnceAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var cache = new EvaluationCache();
        var changed = false;
        var allRules = rules.All();
        foreach (var rule in allRules.Where(r => r.Enabled))
        {
            List<AlertEvaluation> results;
            try { results = Evaluate(rule, now, cache, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Règle {Rule} : évaluation impossible", rule.Name);
                continue;
            }
            changed |= await ApplyAsync(rule, results, now, ct);
        }

        // États orphelins (règle supprimée ou désactivée).
        lock (_lock)
        {
            var active = allRules.Where(r => r.Enabled).Select(r => r.Id).ToHashSet();
            foreach (var id in _states.Where(kv => !active.Contains(kv.Value.RuleId)).Select(kv => kv.Key).ToList())
            {
                _states.Remove(id);
                changed = true;
            }
        }
        if (changed)
        {
            List<AlertState> snapshot;
            lock (_lock) snapshot = _states.Values.Select(Copy).ToList();
            stateStore.ReplaceAll(snapshot);
        }
        LastRunAt = now;
    }

    private async Task<bool> ApplyAsync(AlertRule rule, List<AlertEvaluation> results, DateTime now, CancellationToken ct)
    {
        var changed = false;
        var muted = rule.MutedUntil is { } m && m > now;
        var seen = new HashSet<string>();
        var toNotify = new List<(AlertState State, string Status)>();

        lock (_lock)
        {
            foreach (var r in results)
            {
                seen.Add(r.Key);
                var id = $"{rule.Id}|{r.Key}";
                if (!_states.TryGetValue(id, out var s))
                {
                    if (!r.Breach) continue; // pas d'état à conserver pour une clé saine
                    s = _states[id] = new AlertState { Id = id, RuleId = rule.Id, Key = r.Key, Since = now };
                    changed = true;
                }
                s.Value = r.Value;
                s.Message = r.Message;
                s.Link = r.Link;
                s.LastEvaluatedAt = now;

                if (r.Breach)
                {
                    if (s.Status == "ok")
                    {
                        s.Status = rule.ForMinutes > 0 && !r.IsEvent ? "pending" : "firing";
                        s.Since = now;
                        changed = true;
                        if (s.Status == "firing") toNotify.Add((s, "firing"));
                    }
                    else if (s.Status == "pending" && now - s.Since >= TimeSpan.FromMinutes(rule.ForMinutes))
                    {
                        s.Status = "firing";
                        s.Since = now;
                        changed = true;
                        toNotify.Add((s, "firing"));
                    }
                    else if (s.Status == "firing" && rule.RepeatMinutes > 0 && s.LastNotifiedAt is { } last && now - last >= TimeSpan.FromMinutes(rule.RepeatMinutes))
                    {
                        toNotify.Add((s, "firing"));
                    }
                }
                else if (!r.IsEvent)
                {
                    changed |= Resolve(s, toNotify, now);
                }
            }

            // Clés non évaluées cette fois : l'événement est passé, ou le groupe a disparu.
            foreach (var s in _states.Values.Where(s => s.RuleId == rule.Id && !seen.Contains(s.Key)).ToList())
            {
                var isEvent = rule.Kind == AlertKinds.Error;
                if (isEvent && now - s.LastEvaluatedAt < TimeSpan.FromMinutes(Math.Max(rule.WindowMinutes, 1))) continue;
                if (isEvent)
                {
                    _states.Remove(s.Id);
                    changed = true;
                }
                else changed |= Resolve(s, toNotify, now);
            }

            foreach (var s in _states.Values.Where(s => s.RuleId == rule.Id && s.Status == "ok").ToList())
                if (now - s.Since > TimeSpan.FromHours(1)) { _states.Remove(s.Id); changed = true; }
        }

        foreach (var (state, status) in toNotify)
        {
            if (status == "resolved" && !rule.NotifyResolved) { Record(rule, state, status, []); continue; }
            var sent = muted || rule.Channels.Count == 0
                ? []
                : await notifier.SendAsync(rule.Channels,
                    new AlertNotification(status, rule.Name, rule.Severity, state.Message ?? "", state.Link, rule.Runbook, now), ct);
            lock (_lock)
                if (_states.TryGetValue(state.Id, out var s)) s.LastNotifiedAt = now;
            Record(rule, state, status, sent);
            changed = true;
        }
        return changed;
    }

    private static bool Resolve(AlertState s, List<(AlertState, string)> toNotify, DateTime now)
    {
        if (s.Status == "ok") return false;
        if (s.Status == "firing") toNotify.Add((s, "resolved"));
        s.Status = "ok";
        s.Since = now;
        return true;
    }

    private void Record(AlertRule rule, AlertState s, string status, List<string> sent) => events.Add(new AlertEvent
    {
        RuleId = rule.Id, RuleName = rule.Name, Key = s.Key, Status = status, Severity = rule.Severity,
        Value = s.Value, Message = s.Message, Link = s.Link, NotifiedChannels = sent,
    });

    private static AlertState Copy(AlertState s) => new()
    {
        Id = s.Id, RuleId = s.RuleId, Key = s.Key, Status = s.Status, Since = s.Since, Value = s.Value, Message = s.Message,
        Link = s.Link, LastNotifiedAt = s.LastNotifiedAt, LastEvaluatedAt = s.LastEvaluatedAt,
    };

    // ------------------------------------------------------------------ évaluation

    private sealed class EvaluationCache
    {
        public Dictionary<string, IReadOnlyList<ServiceInfo>> Services { get; } = [];
        public HealthReport? Health { get; set; }
    }

    /// <summary>Évaluation sans effet (aperçu dans l'éditeur de règle).</summary>
    public List<AlertEvaluation> Preview(AlertRule rule, CancellationToken ct) => Evaluate(rule, DateTime.UtcNow, new EvaluationCache(), ct, preview: true);

    private List<AlertEvaluation> Evaluate(AlertRule rule, DateTime now, EvaluationCache cache, CancellationToken ct, bool preview = false)
    {
        var qs = new QueryService(storage) { Env = string.IsNullOrWhiteSpace(rule.Env) ? null : rule.Env };
        var window = TimeSpan.FromMinutes(Math.Clamp(rule.WindowMinutes, 1, 7 * 24 * 60));
        var from = now - window;
        return rule.Kind switch
        {
            AlertKinds.Query => EvaluateQuery(rule, qs, from, now, ct),
            AlertKinds.Http => EvaluateHttp(rule, qs, from, now, cache, ct),
            AlertKinds.Error => EvaluateErrors(rule, qs, from, now, ct, preview),
            AlertKinds.Silence => EvaluateSilence(rule, qs, window, now, cache, ct),
            AlertKinds.Probe => EvaluateProbes(rule),
            AlertKinds.Slo => EvaluateSlos(rule, qs, from, now, ct),
            AlertKinds.Health => EvaluateHealth(rule, cache),
            _ => [],
        };
    }

    private bool Compare(AlertRule rule, double? value) =>
        value is { } v && (rule.Comparison == "below" ? v < rule.Threshold : v > rule.Threshold);

    private static string Num(double? v, string? unit = null)
    {
        if (v is null) return "–";
        var s = Math.Abs(v.Value) >= 100 ? Math.Round(v.Value).ToString("N0", Fr) : v.Value.ToString("0.##", Fr);
        return unit switch
        {
            null or "" => s,
            "%" => s + " %",
            "ms" => v >= 1000 ? (v.Value / 1000).ToString("0.##", Fr) + " s" : s + " ms",
            _ => s + " " + unit,
        };
    }

    /// <summary>Début du message : ce qui est touché (service ou groupe, et environnement).</summary>
    private static string Subject(AlertRule rule, string? group, string fallback)
    {
        var subject = group ?? rule.Service ?? fallback;
        return string.IsNullOrEmpty(rule.Env) ? subject : $"{subject} ({rule.Env})";
    }

    private string Condition(AlertRule rule, string? unit) =>
        $"{(rule.Comparison == "below" ? "seuil bas" : "seuil")} {Num(rule.Threshold, unit)} sur {Minutes(rule.WindowMinutes)}";

    private static string Minutes(int m) => m % 1440 == 0 ? $"{m / 1440} j" : m % 60 == 0 ? $"{m / 60} h" : $"{m} min";

    private static string Enc(string s) => Uri.EscapeDataString(s);

    private List<AlertEvaluation> EvaluateQuery(AlertRule rule, QueryService qs, DateTime from, DateTime to, CancellationToken ct)
    {
        var source = rule.Source ?? "logs";
        var agg = rule.Aggregate ?? "count";
        var label = agg switch { "count" => "nombre", "rate" => "débit", _ => $"{agg} de {rule.Field}" };
        var sourceName = source switch { "spans" => "Spans", "metrics" => "Métriques", _ => "Logs" };
        var what = string.IsNullOrWhiteSpace(rule.Filter) ? sourceName : $"{sourceName} « {rule.Filter} »";
        var link = source switch
        {
            "spans" => $"/traces?q={Enc(rule.Filter ?? "")}",
            "metrics" => "/metrics",
            _ => $"/logs?q={Enc(rule.Filter ?? "")}",
        };
        if (!string.IsNullOrWhiteSpace(rule.GroupBy))
        {
            var result = qs.Custom(new CustomQuery(source, rule.Filter, agg, rule.Field, rule.GroupBy, "top", 50, rule.Service), from, to, ct);
            return (result.Rows ?? []).Select(r => new AlertEvaluation(r.Group,
                Compare(rule, r.Value) && r.Count >= rule.MinCount, r.Value,
                $"{Subject(rule, $"{rule.GroupBy} {r.Group}", what)} : {label} {Num(r.Value, result.Unit)} ({Condition(rule, result.Unit)})",
                link)).ToList();
        }
        var stat = qs.Custom(new CustomQuery(source, rule.Filter, agg, rule.Field, null, "stat", 1, rule.Service), from, to, ct);
        var value = stat.Value ?? (agg is "count" or "rate" ? 0 : null);
        return [new AlertEvaluation("total", Compare(rule, value) && stat.Count >= rule.MinCount, value,
            $"{Subject(rule, null, what)} : {label} {Num(value, stat.Unit)} ({Condition(rule, stat.Unit)})", link)];
    }

    private List<AlertEvaluation> EvaluateHttp(AlertRule rule, QueryService qs, DateTime from, DateTime to, EvaluationCache cache, CancellationToken ct)
    {
        var stat = rule.Stat ?? "errorRate";
        var (label, unit) = stat switch
        {
            "p95" => ("latence p95", "ms"),
            "p99" => ("latence p99", "ms"),
            "p50" => ("latence médiane", "ms"),
            "rate" => ("débit", "req/s"),
            "count" => ("nombre de requêtes", ""),
            _ => ("taux d'erreur", "%"),
        };
        var services = rule.PerService && string.IsNullOrEmpty(rule.Service)
            ? Services(qs, from, to, cache, ct).Where(s => s.Spans > 0).Select(s => (string?)s.Name).ToList()
            : [rule.Service];
        var list = new List<AlertEvaluation>();
        foreach (var service in services)
        {
            var s = qs.HttpSummary(from, to, new HttpFilter(service, rule.Route, null, null, false), ct);
            double? value = stat switch
            {
                "p95" => s.P95Ms,
                "p99" => s.P99Ms,
                "p50" => s.P50Ms,
                "rate" => s.RatePerSecond,
                "count" => s.Count,
                _ => s.Count == 0 ? null : s.ErrorRate,
            };
            var enough = s.Count >= Math.Max(1, rule.MinCount) || stat is "rate" or "count";
            var link = $"/requests?{(stat == "errorRate" ? "status=errors&" : "")}{(service is null ? "" : "service=" + Enc(service) + "&")}q={Enc(rule.Route ?? "")}";
            var detail = stat == "errorRate" ? $" ({s.Errors.ToString("N0", Fr)} sur {s.Count.ToString("N0", Fr)} requêtes)" : "";
            list.Add(new AlertEvaluation(service ?? "total", enough && Compare(rule, value), value,
                $"{Subject(rule, service, "Tous les services")} : {label} {Num(value, unit)}{detail}, {Condition(rule, unit)}", link));
        }
        return list;
    }

    private IReadOnlyList<ServiceInfo> Services(QueryService qs, DateTime from, DateTime to, EvaluationCache cache, CancellationToken ct)
    {
        var key = $"{qs.Env}|{from:O}";
        if (!cache.Services.TryGetValue(key, out var list)) cache.Services[key] = list = qs.Services(from, to, ct);
        return list;
    }

    private List<AlertEvaluation> EvaluateErrors(AlertRule rule, QueryService qs, DateTime from, DateTime to, CancellationToken ct, bool preview)
    {
        var known = KnownErrors(ct);
        var query = new SearchQuery();
        if (!string.IsNullOrEmpty(rule.Service)) query.Services.Add(rule.Service);
        if (rule.CrashesOnly) query.Crash = true;
        var groups = qs.Errors(from, to, query, 200, ct);
        var stateMap = errorStates.Map();
        var list = new List<AlertEvaluation>();
        foreach (var g in groups)
        {
            stateMap.TryGetValue(g.Fingerprint, out var st);
            var status = ErrorStatus.Effective(st, g.LastSeen);
            string? what = null;
            if (!known.Contains(g.Fingerprint)) what = g.Crashes > 0 ? "Nouveau crash" : "Nouvelle erreur";
            else if (rule.IncludeRegressions && status == ErrorStatus.Regressed) what = "Erreur réapparue après résolution";
            if (!preview) lock (known) known.Add(g.Fingerprint);
            if (what is null || status == ErrorStatus.Ignored) continue;
            list.Add(new AlertEvaluation(g.Fingerprint, true, g.Count,
                $"{what} dans {g.Service} : {g.ExceptionType}{(string.IsNullOrEmpty(g.Message) ? "" : " – " + g.Message)}", $"/errors/{g.Fingerprint}", IsEvent: true));
        }
        return list;
    }

    private HashSet<string> KnownErrors(CancellationToken ct)
    {
        if (_knownErrors != null) return _knownErrors;
        // Tout ce qui existe déjà au démarrage est connu : pas de rafale de notifications au lancement.
        var qs = new QueryService(storage);
        var set = qs.Fingerprints(DateTime.UtcNow.AddDays(-Math.Max(1, options.Value.Retention.LogsDays)), DateTime.UtcNow, ct);
        return _knownErrors = set;
    }

    private List<AlertEvaluation> EvaluateSilence(AlertRule rule, QueryService qs, TimeSpan window, DateTime now, EvaluationCache cache, CancellationToken ct)
    {
        var active = Services(qs, now.AddHours(-24), now, cache, ct);
        var targets = string.IsNullOrEmpty(rule.Service) ? active : active.Where(s => s.Name == rule.Service).ToList();
        var list = targets.Select(s =>
        {
            var silent = s.LastSeen is { } last ? now - last : TimeSpan.MaxValue;
            return new AlertEvaluation(s.Name, silent > window, silent == TimeSpan.MaxValue ? null : Math.Round(silent.TotalMinutes),
                silent > window
                    ? $"{s.Name} n'envoie plus rien depuis {HealthService.Human(silent)}{(string.IsNullOrEmpty(rule.Env) ? "" : " (" + rule.Env + ")")}"
                    : $"{s.Name} envoie des données",
                $"/logs?service={Enc(s.Name)}");
        }).ToList();
        if (!string.IsNullOrEmpty(rule.Service) && list.Count == 0)
            list.Add(new AlertEvaluation(rule.Service, true, null, $"{rule.Service} n'a rien envoyé depuis 24 h", $"/logs?service={Enc(rule.Service)}"));
        return list;
    }

    private List<AlertEvaluation> EvaluateProbes(AlertRule rule) =>
        probeStore.All()
            .Where(p => p.Enabled && (string.IsNullOrEmpty(rule.TargetId) || p.Id == rule.TargetId))
            .Select(p =>
            {
                var s = probes.State(p.Id);
                var down = s?.Status == "down";
                var certDays = s?.Last?.CertificateDays;
                var certWarn = rule.Threshold > 0 && certDays is { } d && d < rule.Threshold;
                var message = down
                    ? $"{p.Name} ne répond plus : {s!.Last?.Error ?? "échec"} ({s.ConsecutiveFailures} échecs consécutifs)"
                    : certWarn ? $"Le certificat TLS de {p.Name} expire dans {certDays} jour(s)" : $"{p.Name} répond";
                return new AlertEvaluation(p.Id, down || certWarn, s?.Last?.DurationMs, message, "/uptime");
            }).ToList();

    private List<AlertEvaluation> EvaluateSlos(AlertRule rule, QueryService qs, DateTime from, DateTime to, CancellationToken ct) =>
        slos.All()
            .Where(s => string.IsNullOrEmpty(rule.TargetId) || s.Id == rule.TargetId)
            .Select(s =>
            {
                var (total, bad) = SloCalculator.Count(qs, s, from, to, ct);
                var allowed = 1 - s.TargetPercent / 100;
                double? burn = total == 0 || allowed <= 0 ? null : (double)bad / total / allowed;
                var threshold = rule.Threshold > 0 ? rule.Threshold : 14.4;
                return new AlertEvaluation(s.Id, burn > threshold && total >= rule.MinCount, burn,
                    $"{s.Name} : budget d'erreur consommé {Num(burn)} fois trop vite sur {Minutes(rule.WindowMinutes)} (seuil {Num(threshold)}×). "
                    + $"{bad.ToString("N0", Fr)} événements en échec sur {total.ToString("N0", Fr)}.",
                    $"/slos/{s.Id}");
            }).ToList();

    private List<AlertEvaluation> EvaluateHealth(AlertRule rule, EvaluationCache cache)
    {
        var report = cache.Health ??= health.Check();
        return report.Checks.Select(c => new AlertEvaluation(c.Id,
            c.Status == "critical" || (c.Status == "warning" && rule.Severity == "warning"), c.Value,
            $"Vigil – {c.Name} : {c.Message}", "/system")).ToList();
    }
}
