using System.Text.RegularExpressions;

namespace Wolflog.Server.Monitoring;

/// <summary>
/// Évalue les règles toutes les 30 secondes : ok → en attente (si une durée est demandée) → active → résolue.
/// Notifie à l'activation, à la résolution et, si demandé, en rappel tant que l'alerte reste active.
/// </summary>
public sealed class AlertEngine(
    AlertRuleStore rules, AlertStateStore stateStore, AlertEventStore events, Notifier notifier,
    StorageHost storage, ErrorStateStore errorStates, ProbeEngine probes, ProbeStore probeStore, SloStore slos, HealthService health,
    EnvironmentStore environments, ServerClock clock, IOptions<WolflogServerOptions> options, ILogger<AlertEngine> log) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private static readonly NumberFormatInfo Fr = French.Numbers;

    private readonly Lock _lock = new();
    private Dictionary<string, AlertState> _states = [];
    private HashSet<string>? _knownErrors;
    private readonly Dictionary<string, HashSet<string>> _knownByRule = [];
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
        // Hors plage d'activité : rien ne se déclenche ; ce qui dure (ou l'événement survenu) attend le début de la plage.
        var active = rule.ActiveAt(clock.ToLocal(now));
        var seen = new HashSet<string>();
        var toNotify = new List<(AlertState State, string Status)>();

        void Fire(AlertState s)
        {
            s.Status = "firing";
            s.Since = now;
            changed = true;
            toNotify.Add((s, "firing"));
        }

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
                s.Data = r.Data is null ? null : new Dictionary<string, string>(r.Data);
                s.LastEvaluatedAt = now;

                if (r.Breach)
                {
                    if (s.Status == "ok")
                    {
                        if (active && (rule.ForMinutes == 0 || r.IsEvent)) Fire(s);
                        else
                        {
                            s.Status = "pending";
                            s.Since = now;
                            changed = true;
                        }
                    }
                    else if (s.Status == "pending" && active && (r.IsEvent || now - s.Since >= TimeSpan.FromMinutes(rule.ForMinutes)))
                    {
                        Fire(s);
                    }
                    else if (s.Status == "firing" && active && rule.RepeatMinutes > 0 && s.LastNotifiedAt is { } last && now - last >= TimeSpan.FromMinutes(rule.RepeatMinutes))
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
            var isEvent = rule.Kind == AlertKinds.Error && rule.Stat != "frequent";
            foreach (var s in _states.Values.Where(s => s.RuleId == rule.Id && !seen.Contains(s.Key)).ToList())
            {
                if (isEvent && s.Status == "pending")
                {
                    // Événement survenu hors plage : signalé au début de la plage suivante.
                    if (active) Fire(s);
                    continue;
                }
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
                : await notifier.SendAsync(rule.Channels, Notification(rule, state, status, now, ct), ct);
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
        if (s.Status == "firing")
        {
            (s.Data ??= [])["duree"] = HealthService.Human(now - s.Since);
            toNotify.Add((s, "resolved"));
        }
        s.Status = "ok";
        s.Since = now;
        return true;
    }

    private void Record(AlertRule rule, AlertState s, string status, List<string> sent) => events.Add(new AlertEvent
    {
        RuleId = rule.Id, RuleName = rule.Name, Key = s.Key, Status = status, Severity = rule.Severity,
        Value = s.Value, Message = s.Message, Link = s.Link, NotifiedChannels = sent,
        Service = !string.IsNullOrEmpty(rule.Service) ? rule.Service : s.Data?.GetValueOrDefault("service") is { Length: > 0 } service ? service : null,
    });

    private static AlertState Copy(AlertState s) => new()
    {
        Id = s.Id, RuleId = s.RuleId, Key = s.Key, Status = s.Status, Since = s.Since, Value = s.Value, Message = s.Message,
        Link = s.Link, Data = s.Data is null ? null : new Dictionary<string, string>(s.Data), LastNotifiedAt = s.LastNotifiedAt, LastEvaluatedAt = s.LastEvaluatedAt,
    };

    // ------------------------------------------------------------------ notifications

    /// <summary>Notification avec les variables des modèles de message (communes, puis propres à l'évaluation).</summary>
    private AlertNotification Notification(AlertRule rule, AlertState state, string status, DateTime now, CancellationToken ct)
    {
        var data = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["service"] = rule.Service,
            ["env"] = rule.Env,
            ["element"] = state.Key == "total" ? null : state.Key,
            ["valeur"] = state.Value is null ? null : Num(state.Value),
            ["seuil"] = rule.Kind == AlertKinds.Health || (rule.Kind == AlertKinds.Error && rule.Stat != "frequent") ? null : Num(rule.Threshold),
            ["fenetre"] = Minutes(rule.WindowMinutes),
        };
        if (state.Data != null)
            foreach (var (key, value) in state.Data) data[key] = value;
        var (title, body) = notifier.Templates(rule.TitleTemplate, rule.BodyTemplate);
        if (MessageTemplate.Uses(title + body, "derniere_erreur")) data["derniere_erreur"] = LastError(rule, data["service"], now, ct);
        return new AlertNotification(status, rule.Name, rule.Severity, state.Message ?? "", state.Link, rule.Runbook, now)
        {
            Data = data, TitleTemplate = rule.TitleTemplate, BodyTemplate = rule.BodyTemplate,
        };
    }

    /// <summary>Dernier log d'erreur du service sur la fenêtre de la règle (variable {{derniere_erreur}}).</summary>
    private string? LastError(AlertRule rule, string? service, DateTime now, CancellationToken ct)
    {
        try
        {
            var qs = new QueryService(storage, environments) { Env = string.IsNullOrWhiteSpace(rule.Env) ? null : rule.Env };
            var q = new SearchQuery { MinSeverity = 17 };
            if (!string.IsNullOrEmpty(service)) q.Services.Add(service);
            var from = now - TimeSpan.FromMinutes(Math.Clamp(rule.WindowMinutes, 5, 7 * 24 * 60));
            var item = qs.SearchLogs(from, now, q, 1, null, ct).Items.FirstOrDefault();
            if (item is null) return null;
            var text = string.IsNullOrEmpty(item.ExceptionType) ? item.Body : $"{item.ExceptionType} : {item.ExceptionMessage ?? item.Body}";
            return text.Length > 300 ? text[..300] + "…" : text;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Règle {Rule} : dernière erreur introuvable", rule.Name);
            return null;
        }
    }

    /// <summary>
    /// Notification d'exemple pour l'éditeur de message : évaluation réelle de la règle si possible,
    /// sinon valeurs d'exemple (<c>Sample</c> = true).
    /// </summary>
    public (AlertNotification Notification, bool Sample) SampleNotification(AlertRule? rule, string status, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        AlertEvaluation? e = null;
        if (rule != null)
        {
            try
            {
                var list = Preview(rule, ct);
                e = list.FirstOrDefault(x => x.Breach) ?? list.FirstOrDefault();
            }
            catch (ArgumentException) { /* critères incomplets : valeurs d'exemple */ }
        }
        if (rule is null || e is null)
        {
            var samples = AlertVariables.Samples();
            // La consigne vient de la règle : pas d'exemple inventé quand elle est vide.
            if (rule != null) samples.Remove("consigne");
            return (new AlertNotification(status, rule?.Name ?? "", rule?.Severity ?? "critical", samples["message"]!, "/alerts", rule?.Runbook, now)
            {
                Data = samples, TitleTemplate = rule?.TitleTemplate, BodyTemplate = rule?.BodyTemplate,
            }, true);
        }
        var state = new AlertState
        {
            RuleId = rule.Id, Key = e.Key, Value = e.Value, Message = e.Message, Link = e.Link, Since = now,
            Data = e.Data is null ? null : new Dictionary<string, string>(e.Data),
        };
        return (Notification(rule, state, status, now, ct), false);
    }

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
        // Environnement configuré : valeurs regroupées, application par application (comme dans l'interface).
        var qs = new QueryService(storage, environments) { Env = string.IsNullOrWhiteSpace(rule.Env) ? null : rule.Env };
        var window = TimeSpan.FromMinutes(Math.Clamp(rule.WindowMinutes, 1, 7 * 24 * 60));
        var from = now - window;
        return rule.Kind switch
        {
            AlertKinds.Query => EvaluateQuery(rule, qs, from, now, ct),
            AlertKinds.Http => EvaluateHttp(rule, qs, from, now, ct),
            AlertKinds.Error => EvaluateErrors(rule, qs, from, now, ct, preview),
            AlertKinds.Silence => EvaluateSilence(rule, qs, window, now, cache, ct),
            AlertKinds.Probe => EvaluateProbes(rule, qs, from, now, ct),
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

    /// <summary>Variables {{valeur}} et {{seuil}} avec leur unité.</summary>
    private static Dictionary<string, string> Values(double? value, double threshold, string? unit) =>
        new() { ["valeur"] = Num(value, unit), ["seuil"] = Num(threshold, unit) };

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
                link, Data: Values(r.Value, rule.Threshold, result.Unit))).ToList();
        }
        var stat = qs.Custom(new CustomQuery(source, rule.Filter, agg, rule.Field, null, "stat", 1, rule.Service), from, to, ct);
        var value = stat.Value ?? (agg is "count" or "rate" ? 0 : null);
        return [new AlertEvaluation("total", Compare(rule, value) && stat.Count >= rule.MinCount, value,
            $"{Subject(rule, null, what)} : {label} {Num(value, stat.Unit)} ({Condition(rule, stat.Unit)})", link, Data: Values(value, rule.Threshold, stat.Unit))];
    }

    /// <summary>Libellé et unité d'une mesure HTTP.</summary>
    public static (string Label, string Unit) HttpStat(string? stat) => stat switch
    {
        "percent" => ("part des réponses", "%"),
        "count" => ("nombre de requêtes", ""),
        "rate" => ("débit", "req/s"),
        "p50" => ("latence médiane", "ms"),
        "p90" => ("latence p90", "ms"),
        "p95" => ("latence p95", "ms"),
        "p99" => ("latence p99", "ms"),
        "avg" => ("durée moyenne", "ms"),
        "max" => ("durée maximale", "ms"),
        _ => ("taux d'erreur", "%"),
    };

    private static readonly Dictionary<string, string> HttpGroupLabels = new()
    {
        ["service"] = "", ["route"] = "route", ["path"] = "chemin", ["status"] = "statut", ["method"] = "méthode", ["host"] = "hôte", ["kind"] = "type",
    };

    private List<AlertEvaluation> EvaluateHttp(AlertRule rule, QueryService qs, DateTime from, DateTime to, CancellationToken ct)
    {
        var stat = rule.Stat ?? "errorRate";
        var (label, unit) = HttpStat(stat);
        var groupBy = rule.GroupBy ?? (rule.PerService && string.IsNullOrEmpty(rule.Service) ? "service" : null);
        var rows = qs.HttpAlertRows(from, to, new HttpFilter(rule.Service, rule.Route, null, null, false), rule.Match, groupBy, ct);
        var seconds = Math.Max(1, (to - from).TotalSeconds);
        var search = string.Join(" ", new[] { rule.Route, rule.Match }.Where(s => !string.IsNullOrWhiteSpace(s)));
        var matching = string.IsNullOrWhiteSpace(rule.Match) ? "" : $" « {rule.Match} »";
        var list = new List<AlertEvaluation>();
        foreach (var row in rows)
        {
            double? value = stat switch
            {
                "percent" => row.Total == 0 ? null : 100.0 * row.Matched / row.Total,
                "count" => row.Matched,
                "rate" => row.Matched / seconds,
                "p50" => row.P50Ms,
                "p90" => row.P90Ms,
                "p95" => row.P95Ms,
                "p99" => row.P99Ms,
                "avg" => row.AvgMs,
                "max" => row.MaxMs,
                _ => row.Matched == 0 ? null : 100.0 * row.Errors / row.Matched,
            };
            // Peu de requêtes : un taux ou une latence n'a pas de sens (1 erreur sur 2 requêtes la nuit).
            var basis = stat == "percent" ? row.Total : row.Matched;
            var enough = stat is "rate" or "count" || basis >= Math.Max(1, rule.MinCount);
            var group = groupBy is null ? null : row.Group;
            var service = groupBy == "service" ? row.Group : rule.Service;
            var who = group is null ? null : HttpGroupLabels.TryGetValue(groupBy!, out var g) ? (g.Length == 0 ? group : $"{g} {group}") : $"{groupBy} {group}";
            var detail = stat switch
            {
                "errorRate" => $" ({row.Errors.ToString("N0", Fr)} sur {row.Matched.ToString("N0", Fr)} requêtes)",
                "percent" => $" ({row.Matched.ToString("N0", Fr)} sur {row.Total.ToString("N0", Fr)} requêtes)",
                _ => "",
            };
            var link = $"/requests?{(stat == "errorRate" ? "status=errors&" : "")}{(service is null ? "" : "service=" + Enc(service) + "&")}q={Enc(search)}";
            list.Add(new AlertEvaluation(group ?? "total", enough && Compare(rule, value), value,
                $"{Subject(rule, who, "Tous les services")} : {label}{matching} {Num(value, unit)}{detail}, {Condition(rule, unit)}", link,
                Data: new Dictionary<string, string>(Values(value, rule.Threshold, unit))
                {
                    ["service"] = service ?? "", ["requetes"] = row.Total.ToString("N0", Fr), ["erreurs"] = row.Errors.ToString("N0", Fr),
                }));
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
        var query = new SearchQuery();
        if (!string.IsNullOrEmpty(rule.Service)) query.Services.Add(rule.Service);
        if (rule.CrashesOnly) query.Crash = true;
        var groups = qs.Errors(from, to, query, 200, ct).Where(g => ErrorMatches(rule.Filter, g)).ToList();
        var stateMap = errorStates.Map();
        var list = new List<AlertEvaluation>();

        if (rule.Stat == "frequent")
        {
            // Erreur fréquente : nombre d'occurrences sur la fenêtre, par erreur (résolue quand il redescend).
            foreach (var g in groups)
            {
                stateMap.TryGetValue(g.Fingerprint, out var st);
                if (ErrorStatus.Effective(st, g.LastSeen) == ErrorStatus.Ignored) continue;
                var count = g.Count.ToString("N0", Fr);
                list.Add(new AlertEvaluation(g.Fingerprint, Compare(rule, g.Count), g.Count,
                    $"{g.ExceptionType} dans {g.Service} : {count} occurrence{(g.Count > 1 ? "s" : "")}, {Condition(rule, null)}"
                    + (string.IsNullOrEmpty(g.Message) ? "" : " – " + g.Message), $"/errors/{g.Fingerprint}",
                    Data: new Dictionary<string, string>
                    {
                        ["service"] = g.Service, ["exception"] = g.ExceptionType, ["erreur"] = g.Message ?? "", ["occurrences"] = count,
                        ["element"] = g.ExceptionType, ["valeur"] = count, ["seuil"] = Num(rule.Threshold),
                    }));
            }
            return list;
        }

        var known = KnownErrors(rule.Id, ct);
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
                $"{what} dans {g.Service} : {g.ExceptionType}{(string.IsNullOrEmpty(g.Message) ? "" : " – " + g.Message)}", $"/errors/{g.Fingerprint}", IsEvent: true,
                Data: new Dictionary<string, string>
                {
                    ["service"] = g.Service, ["exception"] = g.ExceptionType, ["erreur"] = g.Message ?? "",
                    ["occurrences"] = g.Count.ToString("N0", Fr), ["element"] = g.ExceptionType,
                }));
        }
        return list;
    }

    /// <summary>
    /// Erreurs déjà connues d'une règle : tout ce qui existait au démarrage, puis ce que la règle a vu. Un ensemble par
    /// règle : deux règles sur le même service (filtres différents) signalent chacune la nouvelle erreur.
    /// </summary>
    private HashSet<string> KnownErrors(string ruleId, CancellationToken ct)
    {
        lock (_knownByRule)
        {
            if (_knownByRule.TryGetValue(ruleId, out var set)) return set;
            // Tout ce qui existe déjà au démarrage est connu : pas de rafale de notifications au lancement. Règle créée
            // ensuite : les erreurs connues à ce moment (vues par les autres règles), pas tout l'historique.
            if (_knownErrors is null)
            {
                var qs = new QueryService(storage);
                _knownErrors = qs.Fingerprints(DateTime.UtcNow.AddDays(-Math.Max(1, options.Value.Retention.LogsDays)), DateTime.UtcNow, ct);
            }
            foreach (var other in _knownByRule.Values)
                lock (other) _knownErrors.UnionWith(other);
            return _knownByRule[ruleId] = [.. _knownErrors];
        }
    }

    /// <summary>Filtre d'une alerte d'erreur : mots (ou « phrases ») présents dans le type, le message ou le service ; -mot exclut.</summary>
    public static bool ErrorMatches(string? filter, ErrorGroup g)
    {
        if (string.IsNullOrWhiteSpace(filter)) return true;
        var text = $"{g.ExceptionType} {g.Message} {g.Service}";
        foreach (Match m in Regex.Matches(filter, "(-?)\"([^\"]*)\"|(-?)(\\S+)"))
        {
            var negated = m.Groups[1].Value == "-" || m.Groups[3].Value == "-";
            var term = m.Groups[2].Success ? m.Groups[2].Value : m.Groups[4].Value;
            if (term.Length == 0) continue;
            if (text.Contains(term, StringComparison.OrdinalIgnoreCase) == negated) return false;
        }
        return true;
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
                $"/logs?service={Enc(s.Name)}",
                Data: new Dictionary<string, string>
                {
                    ["service"] = s.Name, ["seuil"] = Minutes(rule.WindowMinutes),
                    ["valeur"] = silent == TimeSpan.MaxValue ? "plus de 24 h" : HealthService.Human(silent),
                });
        }).ToList();
        if (!string.IsNullOrEmpty(rule.Service) && list.Count == 0)
            list.Add(new AlertEvaluation(rule.Service, true, null, $"{rule.Service} n'a rien envoyé depuis 24 h", $"/logs?service={Enc(rule.Service)}"));
        return list;
    }

    /// <summary>
    /// Sondes : en panne (défaut, et certificat qui expire si un seuil en jours est donné), temps de réponse (délai de
    /// livraison pour une sonde e-mail) moyen sur la fenêtre, disponibilité sur la fenêtre, ou certificat seul.
    /// </summary>
    private List<AlertEvaluation> EvaluateProbes(AlertRule rule, QueryService qs, DateTime from, DateTime to, CancellationToken ct) =>
        probeStore.All()
            .Where(p => p.Enabled && (string.IsNullOrEmpty(rule.TargetId) || p.Id == rule.TargetId))
            .Select(p =>
            {
                var s = probes.State(p.Id);
                var data = new Dictionary<string, string> { ["element"] = p.Name, ["erreur"] = s?.Last?.Error ?? "", ["service"] = p.Service ?? "" };
                var certDays = s?.Last?.CertificateDays;
                switch (rule.Stat)
                {
                    case "duration":
                    {
                        // Moyenne des vérifications de la fenêtre (au moins la dernière).
                        var recent = new List<ProbeResult>();
                        if (s is not null) lock (s) recent.AddRange(s.Recent.Where(r => r.At >= from));
                        if (recent.Count == 0 && s?.Last is { } last) recent.Add(last);
                        double? value = recent.Count == 0 ? null : recent.Average(r => r.DurationMs);
                        var what = p.Type == "email" ? "délai de livraison" : "temps de réponse";
                        data["valeur"] = Num(value, "ms");
                        data["seuil"] = Num(rule.Threshold, "ms");
                        return new AlertEvaluation(p.Id, Compare(rule, value), value,
                            $"{p.Name} : {what} {Num(value, "ms")} ({Condition(rule, "ms")})", "/uptime", Data: data);
                    }
                    case "availability":
                    {
                        var (total, bad) = qs.ProbeGoodBad(p.Id, from, to, ct);
                        double? value = total == 0 ? null : 100.0 * (total - bad) / total;
                        data["valeur"] = Num(value, "%");
                        data["seuil"] = Num(rule.Threshold, "%");
                        return new AlertEvaluation(p.Id, total >= Math.Max(1, rule.MinCount) && Compare(rule, value), value,
                            $"{p.Name} : disponibilité {Num(value, "%")} ({bad.ToString("N0", Fr)} échec{(bad > 1 ? "s" : "")} sur {total.ToString("N0", Fr)} vérifications, {Condition(rule, "%")})",
                            "/uptime", Data: data);
                    }
                    case "certificate":
                    {
                        var expiring = certDays is { } days && days < rule.Threshold;
                        data["valeur"] = certDays is { } v ? Num(v, "jours") : "";
                        data["seuil"] = Num(rule.Threshold, "jours");
                        return new AlertEvaluation(p.Id, expiring, certDays,
                            expiring ? $"Le certificat TLS de {p.Name} expire dans {certDays} jour(s)" : $"Certificat TLS de {p.Name} : {(certDays is null ? "inconnu" : certDays + " jours restants")}",
                            "/uptime", Data: data);
                    }
                    default:
                    {
                        var down = s?.Status == "down";
                        var certWarn = rule.Threshold > 0 && certDays is { } d && d < rule.Threshold;
                        var message = down
                            ? $"{p.Name} ne répond plus : {s!.Last?.Error ?? "échec"} ({s.ConsecutiveFailures} {(s.ConsecutiveFailures > 1 ? "échecs consécutifs" : "échec")})"
                            : certWarn ? $"Le certificat TLS de {p.Name} expire dans {certDays} jour(s)" : $"{p.Name} répond";
                        data["valeur"] = s?.Last?.DurationMs is { } ms ? Num(ms, "ms") : "";
                        data["seuil"] = rule.Threshold > 0 ? Num(rule.Threshold, "jours") : "";
                        return new AlertEvaluation(p.Id, down || certWarn, s?.Last?.DurationMs, message, "/uptime", Data: data);
                    }
                }
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
                    $"/slos/{s.Id}",
                    Data: new Dictionary<string, string> { ["element"] = s.Name, ["valeur"] = Num(burn) + "×", ["seuil"] = Num(threshold) + "×" });
            }).ToList();

    private List<AlertEvaluation> EvaluateHealth(AlertRule rule, EvaluationCache cache)
    {
        var report = cache.Health ??= health.Check();
        return report.Checks.Select(c => new AlertEvaluation(c.Id,
            c.Status == "critical" || (c.Status == "warning" && rule.Severity == "warning"), c.Value,
            $"Wolflog – {c.Name} : {c.Message}", "/system", Data: new Dictionary<string, string> { ["element"] = c.Name })).ToList();
    }
}
