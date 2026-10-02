namespace Wolflog.Server.Configuration;

/// <summary>
/// Type d'un environnement, qui donne sa couleur dans l'interface : production (rouge), recette ou préproduction (ambre),
/// développement (vert), autre (couleur d'accent). Une couleur personnalisée peut le remplacer (<see cref="EnvironmentDefinition.Color"/>).
/// </summary>
public static class EnvironmentKinds
{
    public const string Production = "production";
    public const string Recette = "recette";
    public const string Developpement = "developpement";
    public const string Other = "autre";

    public static bool IsValid(string? kind) => kind is Production or Recette or Developpement or Other;

    /// <summary>Teinte de l'interface (variable CSS du thème) : danger, warn, ok ou accent.</summary>
    public static string Tone(string? kind) => kind switch
    {
        Production => "danger",
        Recette => "warn",
        Developpement => "ok",
        _ => "accent",
    };

    /// <summary>
    /// Type deviné d'après le nom, comme l'interface le fait sans configuration (envTone) : « prod », « live », « prd » d'abord
    /// (« preprod » compris), puis recette, test et préproduction, puis développement.
    /// </summary>
    public static string Guess(string? name)
    {
        var value = (name ?? "").ToLowerInvariant();
        if (Has(value, "prod", "live", "prd")) return Production;
        if (Has(value, "stag", "recette", "rec", "preprod", "pre-prod", "uat", "qa", "test")) return Recette;
        if (Has(value, "dev", "local", "sandbox")) return Developpement;
        return Other;
    }

    private static bool Has(string value, params string[] parts) => parts.Any(value.Contains);
}
