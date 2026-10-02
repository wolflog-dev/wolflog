namespace Wolflog.Server.Configuration;

/// <summary>
/// « Regrouper automatiquement » : rattache les valeurs reçues qui ne le sont pas encore aux environnements usuels
/// (prod, production, prd → Production ; staging, preprod → Préproduction…), créés au besoin à la suite des autres.
/// Une proposition à revoir avant d'enregistrer : rien n'est enregistré ici, et une valeur inconnue (prod-eu, demo…)
/// reste telle quelle.
/// </summary>
public static class EnvironmentSuggestion
{
    private sealed record Family(string Name, string Label, string Kind, string[] Values);

    // Dans l'ordre du sélecteur proposé, de la production au développement. Valeurs comparées en minuscules, sans accent ni séparateur.
    private static readonly Family[] Families =
    [
        new("production", "Production", EnvironmentKinds.Production, ["prod", "production", "prd", "live"]),
        new("preproduction", "Préproduction", EnvironmentKinds.Recette, ["preprod", "preproduction", "pprod", "staging", "stage", "stg"]),
        new("recette", "Recette", EnvironmentKinds.Recette, ["recette", "rec", "uat", "acceptance", "homologation", "homol", "qualification", "qualif"]),
        new("test", "Test", EnvironmentKinds.Recette, ["test", "tests", "testing", "qa"]),
        new("integration", "Intégration", EnvironmentKinds.Recette, ["integration", "int"]),
        new("developpement", "Développement", EnvironmentKinds.Developpement, ["dev", "development", "develop", "developpement", "local", "localhost", "sandbox"]),
    ];

    /// <summary>
    /// Proposition à partir des réglages en cours de saisie (non modifiés) et des valeurs reçues : réglages complétés,
    /// nombre de valeurs regroupées et d'environnements créés. Les réglages propres aux applications ne changent pas.
    /// </summary>
    public static (EnvironmentSettings Settings, int Grouped, int Created) Propose(EnvironmentSettings? draft, IEnumerable<string> received)
    {
        var settings = Copy(draft);
        // Valeurs déjà regroupées (noms puis alias, sans tenir compte de la casse) → environnement.
        var owners = new Dictionary<string, EnvironmentDefinition>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in settings.Environments) owners.TryAdd(e.Name, e);
        foreach (var e in settings.Environments)
            foreach (var alias in e.Aliases)
                owners.TryAdd(alias, e);

        var pending = received.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(v => !owners.ContainsKey(v))
            .Select(v => (Value: v, Family: Families.FirstOrDefault(f => f.Values.Contains(Simplify(v)))))
            .Where(x => x.Family is not null)
            .ToList();
        int grouped = 0, created = 0;
        foreach (var family in Families)
        {
            var values = pending.Where(x => x.Family == family).Select(x => x.Value).Order(StringComparer.OrdinalIgnoreCase).ToList();
            if (values.Count == 0) continue;
            // L'environnement de ce nom, ou celui qui regroupe déjà ce nom ; sinon un nouveau, à la suite.
            if (!owners.TryGetValue(family.Name, out var target))
            {
                target = new EnvironmentDefinition
                {
                    Name = family.Name, Label = family.Label, Kind = family.Kind,
                    Order = settings.Environments.Count == 0 ? 0 : settings.Environments.Max(e => e.Order) + 1,
                };
                settings.Environments.Add(target);
                owners[family.Name] = target;
                created++;
            }
            foreach (var value in values)
            {
                // Le nom en fait déjà partie (« Production » pour production).
                if (!string.Equals(value, target.Name, StringComparison.OrdinalIgnoreCase)) target.Aliases.Add(value);
                owners[value] = target;
                grouped++;
            }
        }
        return (settings, grouped, created);
    }

    /// <summary>Copie des réglages saisis, sans élément vide (la saisie n'est pas modifiée).</summary>
    private static EnvironmentSettings Copy(EnvironmentSettings? draft)
    {
        var json = JsonSerializer.Serialize(draft ?? new EnvironmentSettings());
        var copy = JsonSerializer.Deserialize<EnvironmentSettings>(json) ?? new EnvironmentSettings();
        copy.Environments = [.. (copy.Environments ?? []).OfType<EnvironmentDefinition>().Where(e => !string.IsNullOrWhiteSpace(e.Name))];
        foreach (var e in copy.Environments)
        {
            e.Name = e.Name.Trim();
            e.Aliases = [.. (e.Aliases ?? []).Where(a => !string.IsNullOrWhiteSpace(a)).Select(a => a.Trim())];
        }
        copy.Apps = [.. (copy.Apps ?? []).OfType<AppEnvironments>()];
        return copy;
    }

    /// <summary>Valeur comparée aux valeurs usuelles : minuscules, sans accent, sans tiret, point, souligné ni espace (« Pré-prod » → preprod).</summary>
    private static string Simplify(string value)
    {
        var sb = new StringBuilder(value.Length);
        foreach (var c in value.Trim().ToLowerInvariant())
        {
            if (c is '-' or '_' or '.' or ' ') continue;
            sb.Append(c switch
            {
                'é' or 'è' or 'ê' or 'ë' => 'e',
                'à' or 'â' or 'ä' => 'a',
                'î' or 'ï' => 'i',
                'ô' or 'ö' => 'o',
                'ù' or 'û' or 'ü' => 'u',
                'ç' => 'c',
                _ => c,
            });
        }
        return sb.ToString();
    }
}
