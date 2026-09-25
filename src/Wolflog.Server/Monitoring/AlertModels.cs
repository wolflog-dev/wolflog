using Microsoft.Extensions.Options;
using Wolflog.Server.Configuration;

namespace Wolflog.Server.Monitoring;

/// <summary>Types de règles d'alerte.</summary>
public static class AlertKinds
{
    /// <summary>Requête personnalisée (logs, spans, métriques) comparée à un seuil, éventuellement par groupe.</summary>
    public const string Query = "query";
    /// <summary>Requêtes HTTP entrantes : taux d'erreur, latence, débit.</summary>
    public const string Http = "http";
    /// <summary>Nouvelle erreur jamais vue, ou erreur résolue qui réapparaît.</summary>
    public const string Error = "error";
    /// <summary>Service qui n'envoie plus rien.</summary>
    public const string Silence = "silence";
    /// <summary>Sonde de disponibilité en échec.</summary>
    public const string Probe = "probe";
    /// <summary>Objectif de service (SLO) qui consomme son budget d'erreur trop vite.</summary>
    public const string Slo = "slo";
    /// <summary>Santé de Wolflog lui-même (disque, écriture, réception).</summary>
    public const string Health = "health";

    public static readonly string[] All = [Query, Http, Error, Silence, Probe, Slo, Health];
}

public sealed class AlertRule : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public string Kind { get; set; } = AlertKinds.Http;
    /// <summary>critical ou warning.</summary>
    public string Severity { get; set; } = "critical";

    // Portée
    public string? Service { get; set; }
    public string? Env { get; set; }

    // Requête personnalisée
    public string? Source { get; set; }
    public string? Filter { get; set; }
    public string? Aggregate { get; set; }
    public string? Field { get; set; }
    /// <summary>Évaluation séparée par valeur de ce champ (ex. service, http.route).</summary>
    public string? GroupBy { get; set; }

    // HTTP : errorRate, p95, p99, rate, count
    public string? Stat { get; set; }
    public string? Route { get; set; }
    /// <summary>Une évaluation par service (au lieu du total).</summary>
    public bool PerService { get; set; }

    // Erreurs
    public bool IncludeRegressions { get; set; } = true;
    public bool CrashesOnly { get; set; }

    // Sonde, SLO
    public string? TargetId { get; set; }

    // Seuil
    /// <summary>above ou below.</summary>
    public string Comparison { get; set; } = "above";
    public double Threshold { get; set; }
    /// <summary>Fenêtre d'évaluation.</summary>
    public int WindowMinutes { get; set; } = 5;
    /// <summary>Durée pendant laquelle la condition doit rester vraie avant de déclencher (0 = immédiat).</summary>
    public int ForMinutes { get; set; }
    /// <summary>Rappel tant que l'alerte reste active (0 = jamais).</summary>
    public int RepeatMinutes { get; set; }
    /// <summary>Pas de notification tant que moins de N événements (évite les faux positifs à faible trafic).</summary>
    public long MinCount { get; set; }

    public List<string> Channels { get; set; } = [];
    public bool NotifyResolved { get; set; } = true;
    /// <summary>Consigne pour la personne d'astreinte (lien vers une procédure…).</summary>
    public string? Runbook { get; set; }
    public DateTime? MutedUntil { get; set; }
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class AlertChannel : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>email, teams, slack, webhook.</summary>
    public string Type { get; set; } = "email";
    /// <summary>Adresses (séparées par des virgules) ou URL du webhook.</summary>
    public string Target { get; set; } = "";
    /// <summary>Canal ajouté automatiquement à toutes les nouvelles règles.</summary>
    public bool Default { get; set; }
    public DateTime? LastSentAt { get; set; }
    public DateTime? LastErrorAt { get; set; }
    public string? LastError { get; set; }
}

/// <summary>Paramètres d'envoi (un seul document, id "mail").</summary>
public sealed class NotificationSettings : IEntity
{
    public string Id { get; set; } = "mail";
    /// <summary>Adresse publique de Wolflog, pour les liens dans les notifications (ex. https://wolflog.mondomaine.fr).</summary>
    public string? PublicUrl { get; set; }
    public string? SmtpHost { get; set; }
    public int SmtpPort { get; set; } = 587;
    public bool SmtpSsl { get; set; } = true;
    public string? SmtpUser { get; set; }
    public string? SmtpPassword { get; set; }
    public string? From { get; set; }
}

/// <summary>État courant d'une règle pour une clé (total, un service, une erreur…).</summary>
public sealed class AlertState : IEntity
{
    /// <summary>ruleId|clé.</summary>
    public string Id { get; set; } = "";
    public string RuleId { get; set; } = "";
    public string Key { get; set; } = "";
    /// <summary>ok, pending, firing.</summary>
    public string Status { get; set; } = "ok";
    public DateTime Since { get; set; } = DateTime.UtcNow;
    public double? Value { get; set; }
    public string? Message { get; set; }
    /// <summary>Lien vers les données dans l'interface (chemin relatif).</summary>
    public string? Link { get; set; }
    public DateTime? LastNotifiedAt { get; set; }
    public DateTime LastEvaluatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class AlertEvent : IEntity
{
    public string Id { get; set; } = "";
    public string RuleId { get; set; } = "";
    public string RuleName { get; set; } = "";
    public string Key { get; set; } = "";
    /// <summary>firing ou resolved.</summary>
    public string Status { get; set; } = "firing";
    public string Severity { get; set; } = "critical";
    public DateTime At { get; set; } = DateTime.UtcNow;
    public double? Value { get; set; }
    public string? Message { get; set; }
    public string? Link { get; set; }
    public List<string> NotifiedChannels { get; set; } = [];
}

public sealed class AlertRuleStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertRule>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-rules.json");

public sealed class AlertChannelStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertChannel>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-channels.json");

public sealed class NotificationSettingsStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<NotificationSettings>(o.Value.ResolveDataDirectory(env.ContentRootPath), "notification-settings.json")
{
    public NotificationSettings Current => Get("mail") ?? new NotificationSettings();
}

public sealed class AlertStateStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertState>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-states.json");

public sealed class AlertEventStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertEvent>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-history.json")
{
    public void Add(AlertEvent e, int keep = 2000)
    {
        Upsert(e);
        var all = All();
        if (all.Count > keep + 100) ReplaceAll(all.OrderByDescending(x => x.At).Take(keep));
    }
}
