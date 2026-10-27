namespace Wolflog.Server.Monitoring;

/// <summary>Sonde de disponibilité : appel HTTP(S), connexion TCP ou envoi d'e-mail (réception vérifiée) à intervalle régulier.</summary>
public sealed class Probe : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    /// <summary>http, tcp ou email.</summary>
    public string Type { get; set; } = "http";
    /// <summary>URL (http), hôte:port (tcp) ; e-mail : résumé « serveur → destinataire », calculé.</summary>
    public string Target { get; set; } = "";
    public string Method { get; set; } = "GET";
    public int IntervalSeconds { get; set; } = 60;
    /// <summary>Heures fixes (« HH:mm », heure de Wolflog) : la sonde s'exécute à ces heures au lieu de l'intervalle.</summary>
    public List<string>? ScheduleTimes { get; set; }
    /// <summary>Jours des heures fixes (0 = dimanche … 6 = samedi) ; vide = tous les jours.</summary>
    public List<int>? ScheduleDays { get; set; }
    public int TimeoutSeconds { get; set; } = 10;
    /// <summary>Codes acceptés, ex. "200-399" ou "200,204".</summary>
    public string ExpectedStatus { get; set; } = "200-399";
    /// <summary>Texte qui doit apparaître dans la réponse (facultatif).</summary>
    public string? ExpectedText { get; set; }
    /// <summary>Échecs consécutifs avant de considérer la cible en panne.</summary>
    public int FailuresBeforeDown { get; set; } = 2;
    /// <summary>Service associé (pour relier la sonde aux logs et traces).</summary>
    public string? Service { get; set; }
    public bool IgnoreTlsErrors { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    /// <summary>Réglages d'une sonde e-mail (type email).</summary>
    public EmailProbeSettings? Email { get; set; }

    public Probe Copy() => (Probe)MemberwiseClone();

    public bool HasSchedule() => ScheduleTimes is { Count: > 0 };

    /// <summary>Planification, pour reconnaître un changement : intervalle, ou heures fixes et jours.</summary>
    public string Plan() => HasSchedule()
        ? $"{string.Join(',', ScheduleTimes!)}|{string.Join(',', ScheduleDays ?? [])}"
        : IntervalSeconds.ToString(CultureInfo.InvariantCulture);
}
