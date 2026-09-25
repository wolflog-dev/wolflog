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
