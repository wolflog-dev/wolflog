namespace Wolflog.Client;

/// <summary>Quand enregistrer les corps des requêtes et réponses HTTP.</summary>
public enum HttpBodyCapture
{
    /// <summary>Jamais.</summary>
    Off,
    /// <summary>Seulement quand la requête échoue (statut ≥ 400 ou exception). Défaut.</summary>
    Errors,
    /// <summary>Toujours (dans la limite de <see cref="HttpCaptureOptions.MaxBodyBytes"/>).</summary>
    All,
}
