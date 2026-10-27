namespace Wolflog.Server.Monitoring;

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
    /// <summary>
    /// Évaluation séparée par valeur de ce champ (ex. service, http.route) ; HTTP : service, route, status, method, host,
    /// kind ou un attribut.
    /// </summary>
    public string? GroupBy { get; set; }

    /// <summary>
    /// Ce qui est mesuré. HTTP : errorRate, percent, count, rate, p50, p90, p95, p99, avg, max ; sonde : down (défaut),
    /// duration, availability, certificate ; erreurs : new (défaut) ou frequent.
    /// </summary>
    public string? Stat { get; set; }
    /// <summary>HTTP : requêtes concernées, dans la syntaxe de recherche des requêtes (route, statut, méthode, corps…).</summary>
    public string? Route { get; set; }
    /// <summary>
    /// HTTP : condition sur la réponse (même syntaxe), ex. « status:4xx » ou « response:"stock insuffisant" » : le calcul
    /// porte sur les requêtes concernées qui la remplissent ; percent = leur part parmi les requêtes concernées.
    /// </summary>
    public string? Match { get; set; }
    /// <summary>Une évaluation par service (au lieu du total). Voir aussi <see cref="GroupBy"/>.</summary>
    public bool PerService { get; set; }

    // Erreurs
    public bool IncludeRegressions { get; set; } = true;
    public bool CrashesOnly { get; set; }

    // Sonde, SLO
    public string? TargetId { get; set; }

    // Plage d'activité (heure de Wolflog) : en dehors, l'alerte ne se déclenche pas ; un problème qui dure se déclenche
    // au début de la plage suivante.
    /// <summary>Jours actifs (0 = dimanche … 6 = samedi) ; vide = tous les jours.</summary>
    public List<int>? ActiveDays { get; set; }
    /// <summary>Début (« HH:mm ») ; vide = minuit.</summary>
    public string? ActiveFrom { get; set; }
    /// <summary>Fin (« HH:mm », exclue) ; vide = minuit. Avant le début : la plage passe minuit (22:00 → 06:00).</summary>
    public string? ActiveTo { get; set; }

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
    /// <summary>Modèle du titre de la notification (null = modèle par défaut).</summary>
    public string? TitleTemplate { get; set; }
    /// <summary>Modèle du message (null = modèle par défaut). Voir <see cref="MessageTemplate"/>.</summary>
    public string? BodyTemplate { get; set; }
    public DateTime? MutedUntil { get; set; }
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>La règle peut-elle se déclencher à cette heure locale (plage d'activité) ?</summary>
    public bool ActiveAt(DateTime local) => WeeklyHours.IsActive(ActiveDays, ActiveFrom, ActiveTo, local);
}
