using System.Text.RegularExpressions;

namespace Wolflog.Server.Configuration;

/// <summary>
/// Environnements configurés (environments.json, dans le dossier de données : il fait partie des sauvegardes de la configuration
/// et se relit après une restauration). Les règles compilées (<see cref="Filter"/>) servent tant que le fichier ne change pas.
/// </summary>
public sealed partial class EnvironmentStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<EnvironmentSettings>(o.Value.ResolveDataDirectory(env.ContentRootPath), "environments.json")
{
    public const string DocumentId = "environments";
    private const int MaxEnvironments = 50;
    private const int MaxValues = 200;
    private const int MaxApps = 1000;

    [GeneratedRegex("^[a-z0-9][a-z0-9._-]{0,39}$")]
    private static partial Regex NamePattern();

    [GeneratedRegex("^#?(?:[0-9a-fA-F]{3}){1,2}$")]
    private static partial Regex HexColor();

    private readonly Lock _gate = new();
    private EnvironmentFilter _filter = EnvironmentFilter.None;
    private DateTime _compiledStamp = DateTime.MinValue;

    /// <summary>Réglages enregistrés (vides : aucun regroupement, chaque valeur reçue est un environnement).</summary>
    public EnvironmentSettings Current => Get(DocumentId) ?? new EnvironmentSettings();

    /// <summary>
    /// Règles compilées des réglages enregistrés : recalculées seulement quand le fichier change (enregistrement, restauration,
    /// modification à la main), le coût par requête se limite à lire la date du fichier.
    /// </summary>
    public EnvironmentFilter Filter
    {
        get
        {
            var stamp = Stamp();
            lock (_gate)
            {
                if (stamp != _compiledStamp)
                {
                    _filter = stamp == DateTime.MinValue ? EnvironmentFilter.None : new EnvironmentFilter(Current);
                    _compiledStamp = stamp;
                }
                return _filter;
            }
        }
    }

    private DateTime Stamp() => File.Exists(FilePath) ? File.GetLastWriteTimeUtc(FilePath) : DateTime.MinValue;

    /// <summary>Enregistre des réglages déjà contrôlés (<see cref="Check"/>) ; ils s'appliquent aussitôt à toutes les requêtes.</summary>
    public EnvironmentSettings Save(EnvironmentSettings settings, string? by)
    {
        settings.Id = DocumentId;
        settings.UpdatedAt = DateTime.UtcNow;
        settings.UpdatedBy = by;
        lock (_gate)
        {
            Upsert(settings);
            _filter = new EnvironmentFilter(settings);
            _compiledStamp = Stamp();
        }
        return settings;
    }

    /// <summary>
    /// Réglages saisis, nettoyés : noms en minuscules, espaces retirés, doublons écartés, ordre renuméroté, applications sans
    /// réglage retirées. Sinon le message qui dit ce qui ne va pas : nom ou couleur invalide, valeur regroupée dans deux
    /// environnements, environnement inconnu…
    /// </summary>
    public static (EnvironmentSettings? Settings, string? Error) Check(EnvironmentSettings? input)
    {
        static (EnvironmentSettings?, string?) Fail(string error) => (null, error);

        var sources = (input?.Environments ?? []).OfType<EnvironmentDefinition>()
            .Select((e, i) => (Definition: e, Index: i)).OrderBy(x => x.Definition.Order).ThenBy(x => x.Index).Select(x => x.Definition).ToList();
        if (sources.Count > MaxEnvironments) return Fail($"{MaxEnvironments} environnements au plus.");

        // Valeur (nom ou alias, sans tenir compte de la casse) → environnement qui la regroupe.
        var owners = new Dictionary<string, EnvironmentDefinition>(StringComparer.OrdinalIgnoreCase);
        var environments = new List<EnvironmentDefinition>();
        foreach (var source in sources)
        {
            var name = (source.Name ?? "").Trim().ToLowerInvariant();
            if (name.Length == 0) return Fail("Chaque environnement a besoin d'un nom.");
            if (!NamePattern().IsMatch(name))
                return Fail($"Nom « {Short(name)} » invalide : lettres minuscules sans accent, chiffres, « - », « _ » ou « . », 40 caractères au plus.");
            var label = Text(source.Label) ?? name;
            if (label.Length > 40) return Fail($"Libellé de « {name} » trop long : 40 caractères au plus.");
            var kind = Text(source.Kind)?.ToLowerInvariant() ?? EnvironmentKinds.Other;
            if (!EnvironmentKinds.IsValid(kind)) return Fail($"Type de « {label} » inconnu : production, recette, developpement ou autre.");
            var color = Text(source.Color);
            if (color is not null && !HexColor().IsMatch(color)) return Fail($"Couleur de « {label} » attendue au format #RRGGBB (ex. #0A66C2).");
            if (owners.TryGetValue(name, out var twin)) return Fail($"Deux environnements s'appellent « {name} » ({twin.Label} et {label}).");
            var definition = new EnvironmentDefinition
            {
                Name = name, Label = label, Kind = kind, Color = color is null ? null : NormalizeColor(color), Hidden = source.Hidden, Order = environments.Count,
            };
            owners[name] = definition;
            environments.Add(definition);
        }

        // Alias ensuite : le nom d'un environnement ne peut pas être regroupé dans un autre.
        foreach (var (source, definition) in sources.Zip(environments))
        {
            foreach (var value in source.Aliases ?? [])
            {
                var alias = Text(value);
                if (alias is null) continue;
                if (alias.Length > 100) return Fail($"Valeur trop longue dans « {definition.Label} » : 100 caractères au plus.");
                if (owners.TryGetValue(alias, out var owner))
                {
                    if (owner == definition) continue; // son propre nom, ou un doublon
                    return Fail($"« {alias} » ne peut pas être regroupé à la fois dans « {owner.Label} » et dans « {definition.Label} ».");
                }
                owners[alias] = definition;
                definition.Aliases.Add(alias);
            }
            if (definition.Aliases.Count > MaxValues) return Fail($"« {definition.Label} » : {MaxValues} valeurs regroupées au plus.");
        }

        var apps = new List<AppEnvironments>();
        var services = new HashSet<string>(StringComparer.Ordinal);
        foreach (var source in (input?.Apps ?? []).OfType<AppEnvironments>())
        {
            var service = Text(source.Service);
            if (service is null) return Fail("Réglage d'application sans nom de service.");
            if (service.Length > 200) return Fail($"Nom de service trop long : « {Short(service)} ».");
            if (!services.Add(service)) return Fail($"L'application « {service} » a deux réglages.");
            var app = new AppEnvironments { Service = service };
            foreach (var (value, target) in source.Aliases ?? [])
            {
                var raw = Text(value);
                if (raw is null) continue;
                if (raw.Length > 100) return Fail($"{service} : valeur trop longue (100 caractères au plus).");
                if (app.Aliases.Keys.FirstOrDefault(k => string.Equals(k, raw, StringComparison.OrdinalIgnoreCase)) is { } same)
                    return Fail($"{service} : « {same} » et « {raw} » sont la même valeur (la casse ne compte pas).");
                var name = (target ?? "").Trim().ToLowerInvariant();
                if (name.Length > 0 && !environments.Any(e => e.Name == name))
                    return Fail($"{service} : « {raw} » est rattaché à un environnement inconnu (« {Short(name)} »).");
                // Une valeur égale au nom d'un environnement désignerait les deux : elle se rattache forcément à un environnement.
                if (name.Length == 0 && environments.FirstOrDefault(e => string.Equals(e.Name, raw, StringComparison.OrdinalIgnoreCase)) is { } named)
                    return Fail($"{service} : « {raw} » est le nom de l'environnement « {named.Label} » : rattachez-le à un environnement.");
                app.Aliases[raw] = name;
            }
            foreach (var value in source.Hidden ?? [])
            {
                if (Text(value) is not { } hidden) continue;
                // Environnement configuré : son nom ; valeur non regroupée : telle quelle.
                var entry = environments.FirstOrDefault(e => string.Equals(e.Name, hidden, StringComparison.OrdinalIgnoreCase))?.Name ?? hidden;
                if (!app.Hidden.Contains(entry, StringComparer.OrdinalIgnoreCase)) app.Hidden.Add(entry);
            }
            if (app.Aliases.Count > MaxValues || app.Hidden.Count > MaxValues) return Fail($"{service} : {MaxValues} valeurs au plus.");
            if (app.Aliases.Count > 0 || app.Hidden.Count > 0) apps.Add(app);
        }
        if (apps.Count > MaxApps) return Fail($"{MaxApps} applications au plus.");
        return (new EnvironmentSettings { Environments = environments, Apps = [.. apps.OrderBy(a => a.Service, StringComparer.Ordinal)] }, null);
    }

    /// <summary>Texte saisi sur une seule ligne, sans espaces autour ; null s'il est vide.</summary>
    private static string? Text(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return string.Join(' ', value.Split(['\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)).Trim();
    }

    private static string Short(string value) => value.Length > 40 ? value[..40] + "…" : value;

    /// <summary>#abc ou abc → #aabbcc ; #AABBCC → #aabbcc.</summary>
    private static string NormalizeColor(string color)
    {
        var hex = color.TrimStart('#').ToLowerInvariant();
        return "#" + (hex.Length == 3 ? string.Concat(hex.Select(c => $"{c}{c}")) : hex);
    }
}
