using System.Text.RegularExpressions;

namespace Wolflog.Server.Security;

/// <summary>
/// Services visibles d'un compte : tous, ou une liste de noms et de motifs avec * (« boutique-* »), sans tenir compte
/// de la casse. Appliqué à chaque requête de données (QueryService), au flux en direct et aux objets rattachés à un service
/// (déploiements, profils, sondes, objectifs, alertes).
/// </summary>
public sealed class ServiceScope
{
    public static readonly ServiceScope All = new([]);

    private readonly Regex[] _matchers;

    public ServiceScope(IEnumerable<string>? patterns)
    {
        Patterns = Normalize(patterns);
        _matchers = Patterns.Select(p => new Regex("^" + Regex.Escape(p).Replace("\\*", ".*") + "$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToArray();
    }

    /// <summary>Noms et motifs, sans doublon ; vide : tous les services.</summary>
    public IReadOnlyList<string> Patterns { get; }

    public bool IsAll => Patterns.Count == 0;

    public bool Allows(string? service) => IsAll || (!string.IsNullOrEmpty(service) && _matchers.Any(m => m.IsMatch(service)));

    /// <summary>Condition SQL sur la colonne du service ; null quand tous les services sont visibles.</summary>
    public string? Condition(string column = "service") => IsAll
        ? null
        : "(" + string.Join(" OR ", Patterns.Select(p => $"{column} ILIKE {Sql.Str(Like(p))} ESCAPE '\\'")) + ")";

    private static string Like(string pattern) =>
        pattern.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace('*', '%');

    /// <summary>Noms et motifs nettoyés : espaces retirés, vides et doublons écartés.</summary>
    public static List<string> Normalize(IEnumerable<string>? patterns) =>
        patterns?.Select(p => (p ?? "").Trim()).Where(p => p.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList() ?? [];

    /// <summary>Message d'erreur si la liste n'est pas valable (trop longue, motif trop long ou illisible), sinon null.</summary>
    public static string? Validate(IEnumerable<string>? patterns)
    {
        var list = Normalize(patterns);
        if (list.Count > 100) return "100 services ou motifs au plus.";
        if (list.FirstOrDefault(p => p.Length > 200 || p.Any(char.IsControl)) is { } bad)
            return $"Service ou motif invalide : « {(bad.Length > 40 ? bad[..40] + "…" : bad)} ».";
        if (list.Any(p => p.Trim('*').Length == 0)) return "Un motif ne peut pas être seulement « * » : laissez la liste vide pour tous les services.";
        return null;
    }
}
