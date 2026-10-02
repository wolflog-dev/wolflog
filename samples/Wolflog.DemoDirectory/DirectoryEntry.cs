namespace Wolflog.DemoDirectory;

/// <summary>Entrée de l'annuaire : DN et attributs à valeurs multiples (noms sans casse), mot de passe à part.</summary>
public sealed class DirectoryEntry(string dn)
{
    public string Dn { get; } = dn;

    public Dictionary<string, List<string>> Attributes { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Mot de passe d'un compte : vérifié par la liaison (bind), jamais renvoyé par une recherche.</summary>
    public string? Password { get; set; }

    public IReadOnlyList<string> Values(string attribute) => Attributes.TryGetValue(attribute, out var values) ? values : [];

    public string? First(string attribute) => Values(attribute) is [var first, ..] ? first : null;

    public DirectoryEntry Set(string attribute, params string[] values)
    {
        Attributes[attribute] = [.. values];
        return this;
    }

    public void Append(string attribute, string value)
    {
        if (!Attributes.TryGetValue(attribute, out var values)) Attributes[attribute] = values = [];
        if (!values.Contains(value, StringComparer.OrdinalIgnoreCase)) values.Add(value);
    }
}
