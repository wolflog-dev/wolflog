namespace Wolflog.DemoDirectory;

/// <summary>
/// Filtre de recherche LDAP (RFC 4511, codage BER) lu en prédicat : et, ou, non, égalité, présence, sous-chaînes,
/// comparaisons, correspondance approchée et règles étendues (groupes imbriqués, opérateurs binaires d'Active Directory).
/// </summary>
internal static class SearchFilter
{
    public static Func<DirectoryEntry, bool> Read(AsnReader reader, InMemoryDirectory directory)
    {
        var tag = reader.PeekTag();
        if (tag.TagClass != TagClass.ContextSpecific) throw new AsnContentException("Filtre LDAP inattendu.");
        switch (tag.TagValue)
        {
            case 0 or 1:
            {
                var set = reader.ReadSetOf(skipSortOrderValidation: true, tag);
                var parts = new List<Func<DirectoryEntry, bool>>();
                while (set.HasData) parts.Add(Read(set, directory));
                return tag.TagValue == 0 ? e => parts.All(p => p(e)) : e => parts.Any(p => p(e));
            }
            case 2:
            {
                var inner = Read(reader.ReadSequence(tag), directory);
                return e => !inner(e);
            }
            case 3 or 5 or 6 or 8:
            {
                var assertion = reader.ReadSequence(tag);
                var attribute = Text(assertion.ReadOctetString());
                var value = Text(assertion.ReadOctetString());
                return tag.TagValue switch
                {
                    5 => e => e.Values(attribute).Any(v => string.Compare(v, value, StringComparison.OrdinalIgnoreCase) >= 0),
                    6 => e => e.Values(attribute).Any(v => string.Compare(v, value, StringComparison.OrdinalIgnoreCase) <= 0),
                    _ => e => directory.Equal(e, attribute, value),
                };
            }
            case 4:
            {
                var substrings = reader.ReadSequence(tag);
                var attribute = Text(substrings.ReadOctetString());
                var parts = substrings.ReadSequence();
                string? initial = null, final = null;
                var any = new List<string>();
                while (parts.HasData)
                {
                    var part = parts.PeekTag();
                    var value = Text(parts.ReadOctetString(part));
                    switch (part.TagValue)
                    {
                        case 0: initial = value; break;
                        case 1: any.Add(value); break;
                        default: final = value; break;
                    }
                }
                return e => e.Values(attribute).Any(v => Substring(v, initial, any, final));
            }
            case 7:
            {
                var attribute = Text(reader.ReadOctetString(tag));
                return e => string.Equals(attribute, "objectClass", StringComparison.OrdinalIgnoreCase) || e.Values(attribute).Count > 0;
            }
            case 9:
            {
                var assertion = reader.ReadSequence(tag);
                string? rule = null, attribute = null, value = null;
                while (assertion.HasData)
                {
                    var part = assertion.PeekTag();
                    switch (part.TagValue)
                    {
                        case 1: rule = Text(assertion.ReadOctetString(part)); break;
                        case 2: attribute = Text(assertion.ReadOctetString(part)); break;
                        case 3: value = Text(assertion.ReadOctetString(part)); break;
                        default: assertion.ReadEncodedValue(); break; // dnAttributes : sans objet ici
                    }
                }
                return e => directory.MatchesRule(e, rule, attribute, value ?? "");
            }
            default:
                throw new AsnContentException($"Filtre LDAP non pris en charge ({tag.TagValue}).");
        }
    }

    /// <summary>Sous-chaînes (début*milieu*fin), sans tenir compte de la casse.</summary>
    private static bool Substring(string value, string? initial, List<string> any, string? final)
    {
        var position = 0;
        if (initial is not null)
        {
            if (!value.StartsWith(initial, StringComparison.OrdinalIgnoreCase)) return false;
            position = initial.Length;
        }
        foreach (var part in any)
        {
            var found = value.IndexOf(part, position, StringComparison.OrdinalIgnoreCase);
            if (found < 0) return false;
            position = found + part.Length;
        }
        return final is null || (value.Length - position >= final.Length && value.EndsWith(final, StringComparison.OrdinalIgnoreCase));
    }

    private static string Text(byte[] value) => Encoding.UTF8.GetString(value);
}
