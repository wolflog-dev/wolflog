namespace Wolflog.DemoDirectory;

/// <summary>
/// Une connexion LDAP v3 : messages lus un à un (BER, longueurs définies), réponses dans l'ordre. Comme Active Directory,
/// une liaison avec un mot de passe vide réussit… en anonyme, seule l'entrée racine (RootDSE) se lit sans liaison, et une
/// recherche depuis la racine du domaine se termine par une référence vers une autre partition.
/// </summary>
internal sealed class LdapSession(InMemoryDirectory directory, Stream stream, Action<string> log)
{
    private const int MaxMessage = 1 << 20;

    /// <summary>Compte lié par la dernière liaison (null : anonyme).</summary>
    private DirectoryEntry? _bound;

    public async Task RunAsync(CancellationToken ct)
    {
        while (await ReadMessageAsync(ct) is { } message)
            if (!await HandleAsync(message, ct)) return;
    }

    /// <returns>false : fin de la connexion (unbind, message inattendu).</returns>
    private async Task<bool> HandleAsync(byte[] frame, CancellationToken ct)
    {
        var message = new AsnReader(frame, AsnEncodingRules.BER).ReadSequence();
        if (!message.TryReadInt32(out var id)) return false;
        var operation = message.PeekTag();
        if (operation.TagClass != TagClass.Application) return false;
        switch (operation.TagValue)
        {
            case 0:
                await SendAsync(Bind(id, message.ReadSequence(operation)), ct);
                return true;
            case 2: // unbind
                return false;
            case 3:
                foreach (var response in Search(id, message.ReadSequence(operation))) await SendAsync(response, ct);
                return true;
            case 16: // abandon : rien à répondre
                return true;
            case 23: // opération étendue (StartTLS…)
                await SendAsync(Result(id, 24, LdapResultCode.ProtocolError, "", "Opération étendue non prise en charge (annuaire de démonstration sans TLS)."), ct);
                return true;
            default: // écritures : refusées, avec la réponse du même type
                await SendAsync(Result(id, operation.TagValue + 1, LdapResultCode.UnwillingToPerform, "", "Annuaire de démonstration en lecture seule."), ct);
                return true;
        }
    }

    private byte[] Bind(int id, AsnReader request)
    {
        request.TryReadInt32(out var version);
        var name = Text(request.ReadOctetString());
        var authentication = request.PeekTag();
        if (authentication.TagClass != TagClass.ContextSpecific || authentication.TagValue != 0)
            return Result(id, 1, LdapResultCode.AuthMethodNotSupported, "", "Seule la liaison simple (nom et mot de passe) est prise en charge.");
        var password = Text(request.ReadOctetString(authentication));
        if (version != 3) return Result(id, 1, LdapResultCode.ProtocolError, "", "LDAP v3 attendu.");
        if (password.Length == 0)
        {
            // Comme Active Directory : sans mot de passe, la liaison réussit en anonyme. Un client doit refuser ce cas avant.
            _bound = null;
            log(name.Length == 0 ? "Liaison anonyme." : $"Liaison sans mot de passe pour « {name} » : acceptée en anonyme, comme Active Directory.");
            return Result(id, 1, LdapResultCode.Success, "", "");
        }
        var (account, data) = directory.Authenticate(name, password);
        _bound = account;
        if (account is null)
        {
            log($"Liaison refusée pour « {name} » (data {data}).");
            return Result(id, 1, LdapResultCode.InvalidCredentials, "", $"80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data {data}, v4563");
        }
        log($"Liaison réussie : {account.Dn}");
        return Result(id, 1, LdapResultCode.Success, "", "");
    }

    private IEnumerable<byte[]> Search(int id, AsnReader request)
    {
        var baseDn = Text(request.ReadOctetString());
        var scope = request.ReadEnumeratedValue<SearchScope>();
        request.ReadEnumeratedBytes(); // déréférencement des alias : sans objet
        request.TryReadInt32(out var sizeLimit);
        request.TryReadInt32(out _); // limite de temps
        var typesOnly = request.ReadBoolean();
        var filter = SearchFilter.Read(request, directory);
        var selection = new List<string>();
        var attributes = request.ReadSequence();
        while (attributes.HasData) selection.Add(Text(attributes.ReadOctetString()));

        // Entrée racine (RootDSE) : lisible sans liaison.
        if (baseDn.Length == 0 && scope == SearchScope.BaseObject)
        {
            if (filter(directory.RootDse)) yield return Entry(id, directory.RootDse, selection, typesOnly);
            yield return Result(id, 5, LdapResultCode.Success, "", "");
            yield break;
        }
        if (_bound is null)
        {
            yield return Result(id, 5, LdapResultCode.OperationsError, "",
                "000004DC: LdapErr: DSID-0C090A5C, comment: In order to perform this operation a successful bind must be completed on the connection., data 0, v4563");
            yield break;
        }
        if (directory.Find(baseDn) is not { } baseEntry)
        {
            var matched = directory.MatchedDn(baseDn);
            yield return Result(id, 5, LdapResultCode.NoSuchObject, matched,
                $"0000208D: NameErr: DSID-03100241, problem 2001 (NO_OBJECT), data 0, best match of: '{matched}'");
            yield break;
        }
        var sent = 0;
        foreach (var entry in directory.InScope(baseEntry, scope).Where(filter))
        {
            if (sizeLimit > 0 && sent == sizeLimit)
            {
                yield return Result(id, 5, LdapResultCode.SizeLimitExceeded, "", "Limite de taille atteinte.");
                yield break;
            }
            sent++;
            yield return Entry(id, entry, selection, typesOnly);
        }
        // Comme Active Directory depuis la racine du domaine : une référence vers une autre partition, à ignorer par le client.
        if (scope == SearchScope.WholeSubtree && InMemoryDirectory.SameDn(baseEntry.Dn, directory.RootDn))
            yield return Reference(id, $"ldap://ForestDnsZones.{directory.DnsName}/DC=ForestDnsZones,{directory.RootDn}");
        log($"Recherche sous « {baseDn} » : {sent} entrée(s).");
        yield return Result(id, 5, LdapResultCode.Success, "", "");
    }

    /// <summary>Attributs demandés : tous (liste vide ou « * »), aucun (« 1.1 »), sinon ceux nommés.</summary>
    private static IEnumerable<KeyValuePair<string, List<string>>> Selected(DirectoryEntry entry, List<string> selection)
    {
        if (selection.Contains("1.1")) return [];
        if (selection.Count == 0 || selection.Contains("*")) return entry.Attributes;
        return entry.Attributes.Where(a => selection.Contains(a.Key, StringComparer.OrdinalIgnoreCase));
    }

    private static byte[] Entry(int id, DirectoryEntry entry, List<string> selection, bool typesOnly)
    {
        var writer = new AsnWriter(AsnEncodingRules.BER);
        using (writer.PushSequence())
        {
            writer.WriteInteger(id);
            using (writer.PushSequence(new Asn1Tag(TagClass.Application, 4, isConstructed: true)))
            {
                writer.WriteOctetString(Encoding.UTF8.GetBytes(entry.Dn));
                using (writer.PushSequence())
                {
                    foreach (var (name, values) in Selected(entry, selection))
                    {
                        using (writer.PushSequence())
                        {
                            writer.WriteOctetString(Encoding.UTF8.GetBytes(name));
                            using (writer.PushSetOf())
                            {
                                if (!typesOnly)
                                    foreach (var value in values) writer.WriteOctetString(Encoding.UTF8.GetBytes(value));
                            }
                        }
                    }
                }
            }
        }
        return writer.Encode();
    }

    private static byte[] Reference(int id, string uri)
    {
        var writer = new AsnWriter(AsnEncodingRules.BER);
        using (writer.PushSequence())
        {
            writer.WriteInteger(id);
            using (writer.PushSequence(new Asn1Tag(TagClass.Application, 19, isConstructed: true)))
                writer.WriteOctetString(Encoding.UTF8.GetBytes(uri));
        }
        return writer.Encode();
    }

    /// <summary>Réponse simple (LDAPResult) : liaison (1), fin de recherche (5), opération étendue (24), écritures refusées.</summary>
    private static byte[] Result(int id, int operation, LdapResultCode code, string matchedDn, string message)
    {
        var writer = new AsnWriter(AsnEncodingRules.BER);
        using (writer.PushSequence())
        {
            writer.WriteInteger(id);
            using (writer.PushSequence(new Asn1Tag(TagClass.Application, operation, isConstructed: true)))
            {
                writer.WriteEnumeratedValue(code);
                writer.WriteOctetString(Encoding.UTF8.GetBytes(matchedDn));
                writer.WriteOctetString(Encoding.UTF8.GetBytes(message));
            }
        }
        return writer.Encode();
    }

    /// <summary>Message LDAP complet : étiquette, longueur (forme courte ou longue), contenu. null en fin de connexion.</summary>
    private async Task<byte[]?> ReadMessageAsync(CancellationToken ct)
    {
        var header = new byte[6];
        if (!await ReadExactAsync(header.AsMemory(0, 2), ct)) return null;
        var headerLength = 2;
        int length = header[1];
        if (length >= 0x80)
        {
            var count = length & 0x7F;
            if (count is 0 or > 4) return null; // longueur indéfinie ou démesurée : connexion fermée
            if (!await ReadExactAsync(header.AsMemory(2, count), ct)) return null;
            length = 0;
            for (var i = 0; i < count; i++) length = (length << 8) | header[2 + i];
            headerLength += count;
        }
        if (length is < 0 or > MaxMessage) return null;
        var frame = new byte[headerLength + length];
        header.AsSpan(0, headerLength).CopyTo(frame);
        return await ReadExactAsync(frame.AsMemory(headerLength), ct) ? frame : null;
    }

    private async Task<bool> ReadExactAsync(Memory<byte> buffer, CancellationToken ct)
    {
        try
        {
            await stream.ReadExactlyAsync(buffer, ct);
            return true;
        }
        catch (EndOfStreamException)
        {
            return false;
        }
    }

    private async Task SendAsync(byte[] message, CancellationToken ct)
    {
        await stream.WriteAsync(message, ct);
        await stream.FlushAsync(ct);
    }

    private static string Text(byte[] value) => Encoding.UTF8.GetString(value);
}
