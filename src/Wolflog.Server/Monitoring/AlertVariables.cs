namespace Wolflog.Server.Monitoring;

/// <summary>Variables disponibles dans les modèles de message et leurs valeurs pour une notification.</summary>
public static class AlertVariables
{
    public static readonly IReadOnlyList<AlertVariable> Catalog =
    [
        new("statut", "Statut", "Alerte, Avertissement, Résolu ou Test", "Alerte"),
        new("regle", "Règle", "Nom de la règle", "Taux d'erreur de api-commandes"),
        new("severite", "Gravité", "critique ou avertissement", "critique"),
        new("message", "Message", "Description générée par Wolflog", "api-commandes (prod) : taux d'erreur 7,2 % (36 sur 500 requêtes), seuil 5 % sur 5 min"),
        new("service", "Service", "Service concerné", "api-commandes"),
        new("env", "Environnement", "Environnement surveillé", "prod"),
        new("element", "Élément", "Ce qui déclenche : service, groupe, sonde, erreur…", "api-commandes"),
        new("valeur", "Valeur", "Valeur mesurée, avec son unité", "7,2 %"),
        new("seuil", "Seuil", "Seuil de la règle", "5 %"),
        new("fenetre", "Fenêtre", "Période évaluée", "5 min"),
        new("duree", "Durée", "Durée de l'alerte (à la résolution)", "12 min"),
        new("date", "Date", "Date et heure de la notification", "30/09/2026 14:32"),
        new("lien", "Lien", "Page correspondante dans Wolflog", "https://wolflog.exemple.fr/requests?service=api-commandes"),
        new("consigne", "Consigne", "Consigne saisie dans la règle", "Vérifier la connexion à la base"),
        new("exception", "Exception", "Type d'exception (alertes d'erreur)", "SqlException"),
        new("erreur", "Message d'erreur", "Message de l'exception (alertes d'erreur)", "Timeout expired"),
        new("occurrences", "Occurrences", "Nombre d'occurrences (alertes d'erreur)", "14"),
        new("requetes", "Requêtes", "Requêtes sur la fenêtre (alertes HTTP)", "500"),
        new("erreurs", "Erreurs HTTP", "Requêtes en erreur sur la fenêtre (alertes HTTP)", "36"),
        new("derniere_erreur", "Dernière erreur", "Dernier log d'erreur du service sur la fenêtre", "SqlException : Timeout expired"),
    ];

    /// <summary>Valeurs d'exemple (aperçu sans donnée réelle).</summary>
    public static Dictionary<string, string?> Samples() =>
        Catalog.ToDictionary(v => v.Name, v => (string?)v.Sample, StringComparer.OrdinalIgnoreCase);

    /// <summary>Valeurs pour une notification : champs communs, puis données propres à la règle et à l'évaluation.</summary>
    public static Dictionary<string, string?> Resolve(AlertNotification n, string? absoluteLink)
    {
        var vars = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["statut"] = Status(n.Status, n.Severity),
            ["regle"] = n.RuleName,
            ["severite"] = n.Severity == "warning" ? "avertissement" : "critique",
            ["message"] = n.Message,
            ["date"] = n.At.ToLocalTime().ToString("dd/MM/yyyy HH:mm", CultureInfo.InvariantCulture),
            ["lien"] = absoluteLink,
            ["consigne"] = n.Runbook,
        };
        // Les données complètent les champs communs sans les remplacer (règle réelle + valeurs d'exemple dans l'aperçu).
        foreach (var (key, value) in n.Data)
            if (!string.IsNullOrWhiteSpace(value) && (!vars.TryGetValue(key, out var current) || string.IsNullOrWhiteSpace(current))) vars[key] = value;
        return vars;
    }

    public static string Status(string status, string severity) => status switch
    {
        "resolved" => "Résolu",
        "test" => "Test",
        _ => severity == "warning" ? "Avertissement" : "Alerte",
    };
}
