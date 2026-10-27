using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace Wolflog.Tests;

/// <summary>
/// Serveur SMTP + IMAP minimal en mémoire (sans TLS), pour tester la sonde e-mail avec le vrai client MailKit : une boîte
/// unique avec les dossiers INBOX et Junk. Ce qui est accepté en SMTP est déposé dans <see cref="DeliverTo"/> après
/// <see cref="DeliveryDelay"/> (null : jamais livré).
/// </summary>
public sealed partial class FakeMailServer : IAsyncDisposable
{
    public const string User = "sonde@exemple.test";
    public const string Password = "mot-de-passe-de-test";

    private readonly TcpListener _smtp = new(IPAddress.Loopback, 0);
    private readonly TcpListener _imap = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<string, List<Message>> _folders = new() { ["INBOX"] = [], ["Junk"] = [] };
    private int _nextUid;

    public int SmtpPort => ((IPEndPoint)_smtp.LocalEndpoint).Port;
    public int ImapPort => ((IPEndPoint)_imap.LocalEndpoint).Port;
    public string? DeliverTo { get; set; } = "INBOX";
    public TimeSpan DeliveryDelay { get; set; } = TimeSpan.FromMilliseconds(300);
    public int Accepted;
    /// <summary>false : relais qui accepte d'envoyer sans authentification (réseau de l'entreprise).</summary>
    public bool RequireAuth { get; set; } = true;
    /// <summary>false : comme Exchange Online, SEARCH HEADER sur un en-tête personnalisé ne trouve rien.</summary>
    public bool HeaderSearch { get; set; } = true;
    /// <summary>Tentatives d'authentification SMTP (tous mécanismes).</summary>
    public int SmtpAuthAttempts;

    public FakeMailServer()
    {
        _smtp.Start();
        _imap.Start();
        _ = Accept(_smtp, ServeSmtp);
        _ = Accept(_imap, ServeImap);
    }

    public int Count(string folder) { lock (_folders) return _folders[folder].Count; }

    /// <summary>Message déposé directement (reste d'un essai précédent, courrier de l'utilisateur).</summary>
    public void Deposit(string folder, string raw) { lock (_folders) _folders[folder].Add(new Message(Interlocked.Increment(ref _nextUid), raw, DateTime.UtcNow)); }

    private sealed record Message(int Uid, string Raw, DateTime Received)
    {
        public bool Deleted { get; set; }
    }

    private async Task Accept(TcpListener listener, Func<TcpClient, Task> serve)
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await listener.AcceptTcpClientAsync(_stop.Token); }
            catch { return; }
            _ = Task.Run(async () =>
            {
                using (client)
                {
                    try { await serve(client); }
                    catch (Exception ex) when (ex is IOException or SocketException or ObjectDisposedException or OperationCanceledException) { }
                }
            });
        }
    }

    // ------------------------------------------------------------------ SMTP

    private async Task ServeSmtp(TcpClient client)
    {
        var (reader, writer) = Open(client);
        await writer.WriteLineAsync("220 faux-serveur ESMTP");
        var authenticated = false;
        while (await reader.ReadLineAsync() is { } line)
        {
            var verb = line.Split(' ')[0].ToUpperInvariant();
            switch (verb)
            {
                case "EHLO":
                    await writer.WriteLineAsync("250-faux-serveur\r\n250 AUTH PLAIN XOAUTH2");
                    break;
                case "AUTH":
                    Interlocked.Increment(ref SmtpAuthAttempts);
                    var parts = line.Split(' ');
                    var encoded = parts.Length > 2 ? parts[2] : null;
                    if (encoded is null)
                    {
                        await writer.WriteLineAsync("334 ");
                        encoded = await reader.ReadLineAsync() ?? "";
                    }
                    if (parts[1].Equals("XOAUTH2", StringComparison.OrdinalIgnoreCase))
                    {
                        authenticated = OAuthAccepted(encoded);
                        await writer.WriteLineAsync(authenticated ? "235 2.7.0 Authentication successful" : "535 5.7.3 Authentication unsuccessful");
                        break;
                    }
                    var plain = Encoding.UTF8.GetString(Convert.FromBase64String(encoded)).Split('\0');
                    authenticated = plain is [_, User, Password];
                    await writer.WriteLineAsync(authenticated ? "235 2.7.0 Authentification réussie" : "535 5.7.8 Identifiants refusés");
                    break;
                case "MAIL":
                    await writer.WriteLineAsync(authenticated || !RequireAuth ? "250 2.1.0 Ok" : "530 5.7.0 Authentification requise");
                    break;
                case "RCPT":
                    await writer.WriteLineAsync("250 2.1.5 Ok");
                    break;
                case "DATA":
                    await writer.WriteLineAsync("354 Fin par <CRLF>.<CRLF>");
                    var raw = new StringBuilder();
                    while (await reader.ReadLineAsync() is { } data && data != ".") raw.Append(data.StartsWith("..") ? data[1..] : data).Append("\r\n");
                    Interlocked.Increment(ref Accepted);
                    if (DeliverTo is { } folder) _ = DeliverLater(folder, raw.ToString());
                    await writer.WriteLineAsync("250 2.0.0 Ok: queued as FAUX123");
                    break;
                case "QUIT":
                    await writer.WriteLineAsync("221 2.0.0 Au revoir");
                    return;
                default:
                    await writer.WriteLineAsync("250 Ok");
                    break;
            }
        }
    }

    /// <summary>Jetons OAuth acceptés (SASL XOAUTH2) pour <see cref="User"/>.</summary>
    public HashSet<string> Tokens { get; } = [];

    /// <summary>Réponse XOAUTH2 : base64("user=…\x01auth=Bearer …\x01\x01").</summary>
    private bool OAuthAccepted(string encoded)
    {
        var parts = Encoding.UTF8.GetString(Convert.FromBase64String(encoded)).Split('\x01');
        if (parts is not [var user, var auth, "", ""] || user != "user=" + User || !auth.StartsWith("auth=Bearer ", StringComparison.Ordinal)) return false;
        lock (Tokens) return Tokens.Contains(auth["auth=Bearer ".Length..]);
    }

    private async Task DeliverLater(string folder, string raw)
    {
        await Task.Delay(DeliveryDelay);
        Deposit(folder, raw);
    }

    // ------------------------------------------------------------------ IMAP

    [GeneratedRegex(@"^(\S+) (?:UID )?(\S+)(?: (.*))?$", RegexOptions.IgnoreCase)]
    private static partial Regex ImapCommand();

    private async Task ServeImap(TcpClient client)
    {
        var (reader, writer) = Open(client);
        await writer.WriteLineAsync("* OK [CAPABILITY IMAP4rev1 LITERAL+ AUTH=XOAUTH2] faux serveur prêt");
        string? selected = null;
        while (await reader.ReadLineAsync() is { } line)
        {
            var m = ImapCommand().Match(line);
            if (!m.Success) continue;
            var (tag, command, args) = (m.Groups[1].Value, m.Groups[2].Value.ToUpperInvariant(), m.Groups[3].Value);
            switch (command)
            {
                case "CAPABILITY":
                    await writer.WriteLineAsync("* CAPABILITY IMAP4rev1 LITERAL+ AUTH=XOAUTH2");
                    await writer.WriteLineAsync($"{tag} OK CAPABILITY terminé");
                    break;
                case "AUTHENTICATE":
                    var sasl = args.Split(' ');
                    var response = sasl.Length > 1 ? sasl[1] : null;
                    if (response is null)
                    {
                        await writer.WriteLineAsync("+ ");
                        response = await reader.ReadLineAsync() ?? "";
                    }
                    await writer.WriteLineAsync(sasl[0].Equals("XOAUTH2", StringComparison.OrdinalIgnoreCase) && OAuthAccepted(response)
                        ? $"{tag} OK [CAPABILITY IMAP4rev1 LITERAL+] AUTHENTICATE completed." : $"{tag} NO AUTHENTICATE failed.");
                    break;
                case "LOGIN":
                    var ok = args == $"\"{User}\" \"{Password}\"" || args == $"{User} {Password}";
                    await writer.WriteLineAsync(ok ? $"{tag} OK [CAPABILITY IMAP4rev1 LITERAL+] connecté" : $"{tag} NO [AUTHENTICATIONFAILED] identifiants refusés");
                    break;
                case "LIST":
                    if (args.EndsWith("\"\""))
                        await writer.WriteLineAsync("* LIST (\\Noselect) \"/\" \"\"");
                    else
                        foreach (var name in _folders.Keys.Where(n => args.Contains('%') || args.Contains('*') || args.Contains(n, StringComparison.OrdinalIgnoreCase)))
                            await writer.WriteLineAsync($"* LIST (\\HasNoChildren) \"/\" {name}");
                    await writer.WriteLineAsync($"{tag} OK LIST terminé");
                    break;
                case "SELECT" or "EXAMINE":
                    selected = args.Trim('"');
                    if (!_folders.ContainsKey(selected)) { await writer.WriteLineAsync($"{tag} NO dossier inconnu"); selected = null; break; }
                    int exists;
                    lock (_folders) exists = _folders[selected].Count;
                    await writer.WriteLineAsync("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
                    await writer.WriteLineAsync("* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)] ok");
                    await writer.WriteLineAsync($"* {exists} EXISTS");
                    await writer.WriteLineAsync("* 0 RECENT");
                    await writer.WriteLineAsync("* OK [UIDVALIDITY 1] ok");
                    await writer.WriteLineAsync($"* OK [UIDNEXT {_nextUid + 1}] ok");
                    await writer.WriteLineAsync($"{tag} OK [{(command == "SELECT" ? "READ-WRITE" : "READ-ONLY")}] sélectionné");
                    break;
                case "NOOP" or "CHECK":
                    await writer.WriteLineAsync($"{tag} OK {command} terminé");
                    break;
                case "SEARCH":
                    // UID SEARCH HEADER X-Wolflog-Probe "valeur" (ou valeur sans guillemets) ; UID SEARCH ALL.
                    var search = Regex.Match(args, @"HEADER (\S+) ""?([^""]*)""?", RegexOptions.IgnoreCase);
                    var everything = args.Trim().Equals("ALL", StringComparison.OrdinalIgnoreCase);
                    List<int> uids;
                    lock (_folders)
                        uids = selected is null ? [] : _folders[selected]
                            .Where(x => !x.Deleted && (everything
                                || (HeaderSearch && search.Success && HeaderContains(x.Raw, search.Groups[1].Value, search.Groups[2].Value))))
                            .Select(x => x.Uid).ToList();
                    await writer.WriteLineAsync("* SEARCH" + string.Concat(uids.Select(u => " " + u)));
                    await writer.WriteLineAsync($"{tag} OK SEARCH terminé");
                    break;
                case "FETCH":
                    // En-têtes demandés : BODY.PEEK[HEADER.FIELDS (X-WOLFLOG-PROBE)], rendus en littéral.
                    var fields = Regex.Match(args, @"BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]", RegexOptions.IgnoreCase);
                    foreach (var msg in Pick(selected, args.Split(' ')[0]))
                    {
                        var head = $"* {SequenceOf(selected!, msg)} FETCH (UID {msg.Uid} INTERNALDATE \"{msg.Received.ToString("dd-MMM-yyyy HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture)} +0000\"";
                        if (!fields.Success)
                        {
                            await writer.WriteLineAsync(head + ")");
                            continue;
                        }
                        var names = fields.Groups[1].Value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                        var lines = msg.Raw.Split("\r\n").TakeWhile(l => l.Length > 0)
                            .Where(l => names.Any(n => l.StartsWith(n + ":", StringComparison.OrdinalIgnoreCase)));
                        var literal = string.Concat(lines.Select(l => l + "\r\n")) + "\r\n";
                        await writer.WriteLineAsync($"{head} BODY[HEADER.FIELDS ({fields.Groups[1].Value})] {{{Encoding.UTF8.GetByteCount(literal)}}}");
                        await writer.WriteAsync(literal);
                        await writer.WriteLineAsync(")");
                    }
                    await writer.WriteLineAsync($"{tag} OK FETCH terminé");
                    break;
                case "STORE":
                    foreach (var msg in Pick(selected, args.Split(' ')[0])) msg.Deleted = true;
                    await writer.WriteLineAsync($"{tag} OK STORE terminé");
                    break;
                case "EXPUNGE":
                    if (selected is not null)
                        lock (_folders) _folders[selected].RemoveAll(x => x.Deleted);
                    await writer.WriteLineAsync($"{tag} OK EXPUNGE terminé");
                    break;
                case "CLOSE" or "UNSELECT":
                    selected = null;
                    await writer.WriteLineAsync($"{tag} OK terminé");
                    break;
                case "LOGOUT":
                    await writer.WriteLineAsync("* BYE au revoir");
                    await writer.WriteLineAsync($"{tag} OK LOGOUT terminé");
                    return;
                default:
                    await writer.WriteLineAsync($"{tag} BAD commande non prise en charge : {command}");
                    break;
            }
        }
    }

    private List<Message> Pick(string? folder, string set)
    {
        if (folder is null) return [];
        var wanted = set.Split(',').SelectMany(part => part.Split(':') is [var a, var b]
            ? Enumerable.Range(int.Parse(a), b == "*" ? 100_000 : int.Parse(b) - int.Parse(a) + 1)
            : [int.Parse(part)]).ToHashSet();
        lock (_folders) return _folders[folder].Where(x => wanted.Contains(x.Uid)).ToList();
    }

    private int SequenceOf(string folder, Message msg) { lock (_folders) return _folders[folder].IndexOf(msg) + 1; }

    private static bool HeaderContains(string raw, string name, string value) =>
        raw.Split("\r\n").TakeWhile(l => l.Length > 0)
            .Any(l => l.StartsWith(name + ":", StringComparison.OrdinalIgnoreCase) && l[(name.Length + 1)..].Contains(value, StringComparison.OrdinalIgnoreCase));

    private static (StreamReader, StreamWriter) Open(TcpClient client)
    {
        var stream = client.GetStream();
        return (new StreamReader(stream, Encoding.UTF8), new StreamWriter(stream, new UTF8Encoding(false)) { NewLine = "\r\n", AutoFlush = true });
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _smtp.Stop();
        _imap.Stop();
        _stop.Dispose();
    }
}
