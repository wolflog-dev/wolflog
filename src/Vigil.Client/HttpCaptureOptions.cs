namespace Vigil.Client;

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

/// <summary>Capture du contenu HTTP (requêtes reçues et appels HttpClient), visible dans le détail des traces.</summary>
public sealed class HttpCaptureOptions
{
    /// <summary>Enregistre les en-têtes (les en-têtes sensibles sont masqués).</summary>
    public bool Headers { get; set; } = true;

    public HttpBodyCapture Bodies { get; set; } = HttpBodyCapture.Errors;

    /// <summary>Taille maximale conservée par corps ; au-delà, le contenu est tronqué.</summary>
    public int MaxBodyBytes { get; set; } = 16 * 1024;

    /// <summary>En-têtes dont la valeur est remplacée par ***.</summary>
    public List<string> RedactedHeaders { get; set; } =
        ["Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie", "X-Api-Key", "Api-Key", "X-Vigil-Key", "X-Auth-Token"];

    /// <summary>Champs JSON / formulaire dont la valeur est remplacée par *** (sans tenir compte de la casse).</summary>
    public List<string> RedactedFields { get; set; } =
        ["password", "pwd", "passwd", "secret", "token", "access_token", "refresh_token", "id_token", "apikey", "api_key",
         "authorization", "client_secret", "creditcard", "cardnumber", "card_number", "cvv", "cvc", "iban"];
}
