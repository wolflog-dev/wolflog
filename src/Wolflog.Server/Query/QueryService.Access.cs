namespace Wolflog.Server.Query;

/// <summary>Services visibles (profil d'accès) : une condition de plus dans chaque requête, à côté de la période et de l'environnement.</summary>
public sealed partial class QueryService
{
    /// <summary>Services visibles du compte connecté (posé par le filtre de l'API) ; tous pour le moteur d'alertes et les tâches internes.</summary>
    public ServiceScope Scope { get; set; } = ServiceScope.All;

    /// <summary>Condition sur les services visibles ; null s'ils le sont tous.</summary>
    private string? ScopeFilter() => Scope.Condition();

    /// <summary>« AND condition » sur les services visibles, à ajouter à une clause WHERE écrite à la main ; vide s'ils le sont tous.</summary>
    private string ScopeAnd() => Scope.Condition() is { } condition ? " AND " + condition : "";

    /// <summary>L'erreur (empreinte) a-t-elle au moins une occurrence dans un service visible ? (changement de statut d'un compte limité)</summary>
    public bool HasFingerprint(string fingerprint, CancellationToken ct)
    {
        var q = new SearchQuery { Fingerprint = fingerprint };
        var source = storage.Logs.Source(storage.Logs.Snapshot, q.MayMatch);
        var found = false;
        Read($"SELECT 1 FROM {source} WHERE fingerprint = {Sql.Str(fingerprint)}{ScopeAnd()} LIMIT 1", ct, _ => found = true);
        return found;
    }
}
