using System.Buffers.Binary;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Wolflog.Server.Monitoring;

/// <summary>
/// Enregistrements DNS de la messagerie d'un domaine (MX, TXT, SRV), que .NET ne sait pas lire : requête aux serveurs DNS
/// de la machine (ceux de l'entreprise, comme le font Outlook ou Thunderbird), en UDP puis en TCP si la réponse est
/// tronquée, sans passer par un service extérieur.
/// </summary>
public sealed class MailDns(IReadOnlyList<IPEndPoint>? servers = null)
{
    public const int Mx = 15;
    public const int Txt = 16;
    public const int Srv = 33;

    /// <summary>Priorité (MX, SRV), poids et port (SRV) ; Value : hôte (MX, SRV) ou texte (TXT).</summary>
    public sealed record Record(int Priority, int Weight, int Port, string Value);

    /// <summary>Délai par serveur DNS.</summary>
    internal static TimeSpan Timeout = TimeSpan.FromSeconds(3);

    /// <summary>Serveurs DNS configurés sur la machine (cartes réseau actives).</summary>
    public static IReadOnlyList<IPEndPoint> SystemServers()
    {
        var list = new List<IPAddress>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            try { list.AddRange(nic.GetIPProperties().DnsAddresses); }
            catch (NetworkInformationException) { }
        }
        // Adresses IPv6 de site (fec0::) : obsolètes, jamais joignables.
        return list.Where(a => a.AddressFamily == AddressFamily.InterNetwork || (a.AddressFamily == AddressFamily.InterNetworkV6 && !a.IsIPv6SiteLocal))
            .Distinct().Select(a => new IPEndPoint(a, 53)).ToList();
    }

    /// <summary>Enregistrements du type demandé ; aucun si le nom n'existe pas ou si aucun serveur ne répond.</summary>
    public async Task<IReadOnlyList<Record>> QueryAsync(string name, int type, CancellationToken ct)
    {
        foreach (var server in servers ?? SystemServers())
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(Timeout);
            try
            {
                var id = (ushort)Random.Shared.Next(1, ushort.MaxValue);
                var query = Build(id, name, type);
                var answer = await UdpAsync(server, query, id, timeout.Token);
                if (answer is not null && (BinaryPrimitives.ReadUInt16BigEndian(answer.AsSpan(2)) & 0x0200) != 0)
                    answer = await TcpAsync(server, query, timeout.Token); // tronquée : TCP
                if (answer is null) continue;
                var rcode = answer[3] & 0x0F;
                if (rcode == 3) return []; // le nom n'existe pas
                if (rcode != 0) continue;
                return Parse(answer, type);
            }
            catch (Exception ex) when (ex is SocketException or IOException or OperationCanceledException && !ct.IsCancellationRequested)
            {
                // serveur suivant
            }
        }
        return [];
    }

    private static async Task<byte[]?> UdpAsync(IPEndPoint server, byte[] query, ushort id, CancellationToken ct)
    {
        using var udp = new UdpClient(server.AddressFamily);
        await udp.SendAsync(query, server, ct);
        while (true)
        {
            var result = await udp.ReceiveAsync(ct);
            if (!result.RemoteEndPoint.Address.Equals(server.Address) || result.Buffer.Length < 12) continue;
            if (BinaryPrimitives.ReadUInt16BigEndian(result.Buffer) != id || (result.Buffer[2] & 0x80) == 0) continue;
            return result.Buffer;
        }
    }

    private static async Task<byte[]?> TcpAsync(IPEndPoint server, byte[] query, CancellationToken ct)
    {
        using var tcp = new TcpClient(server.AddressFamily);
        await tcp.ConnectAsync(server, ct);
        var stream = tcp.GetStream();
        var framed = new byte[query.Length + 2];
        BinaryPrimitives.WriteUInt16BigEndian(framed, (ushort)query.Length);
        query.CopyTo(framed, 2);
        await stream.WriteAsync(framed, ct);
        var length = new byte[2];
        await stream.ReadExactlyAsync(length, ct);
        var answer = new byte[BinaryPrimitives.ReadUInt16BigEndian(length)];
        await stream.ReadExactlyAsync(answer, ct);
        return answer.Length >= 12 ? answer : null;
    }

    /// <summary>Requête : en-tête (récursion demandée), question, et EDNS0 (réponses UDP jusqu'à 4 096 octets).</summary>
    internal static byte[] Build(ushort id, string name, int type)
    {
        var bytes = new List<byte>(64);
        void U16(int v) { bytes.Add((byte)(v >> 8)); bytes.Add((byte)v); }
        U16(id);
        U16(0x0100); // RD
        U16(1); // question
        U16(0);
        U16(0);
        U16(1); // OPT
        foreach (var label in name.Trim().TrimEnd('.').Split('.'))
        {
            var ascii = Encoding.ASCII.GetBytes(label);
            if (ascii.Length is 0 or > 63) throw new FormatException($"Nom de domaine invalide : {name}");
            bytes.Add((byte)ascii.Length);
            bytes.AddRange(ascii);
        }
        bytes.Add(0);
        U16(type);
        U16(1); // IN
        // OPT : nom racine, type 41, taille UDP 4096, TTL 0, aucune donnée.
        bytes.Add(0);
        U16(41);
        U16(4096);
        U16(0);
        U16(0);
        U16(0);
        return [.. bytes];
    }

    internal static List<Record> Parse(byte[] m, int type)
    {
        var records = new List<Record>();
        var questions = BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(4));
        var answers = BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(6));
        var at = 12;
        for (var i = 0; i < questions; i++)
        {
            ReadName(m, ref at);
            at += 4;
        }
        for (var i = 0; i < answers && at + 10 <= m.Length; i++)
        {
            ReadName(m, ref at);
            var rtype = BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(at));
            var length = BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(at + 8));
            var data = at + 10;
            at = data + length;
            if (rtype != type || at > m.Length) continue;
            switch (type)
            {
                case Mx:
                {
                    var p = data + 2;
                    records.Add(new Record(BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(data)), 0, 0, ReadName(m, ref p)));
                    break;
                }
                case Srv:
                {
                    var p = data + 6;
                    records.Add(new Record(BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(data)), BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(data + 2)),
                        BinaryPrimitives.ReadUInt16BigEndian(m.AsSpan(data + 4)), ReadName(m, ref p)));
                    break;
                }
                case Txt:
                {
                    // Une ou plusieurs chaînes <longueur><texte>, à mettre bout à bout.
                    var text = new StringBuilder();
                    for (var p = data; p < at;)
                    {
                        var n = m[p++];
                        text.Append(Encoding.UTF8.GetString(m, p, Math.Min(n, at - p)));
                        p += n;
                    }
                    records.Add(new Record(0, 0, 0, text.ToString()));
                    break;
                }
            }
        }
        return records;
    }

    /// <summary>Nom de domaine, pointeurs de compression compris.</summary>
    internal static string ReadName(byte[] m, ref int at)
    {
        var labels = new List<string>();
        var p = at;
        var jumped = false;
        for (var guard = 0; guard < 128 && p < m.Length; guard++)
        {
            var len = m[p];
            if (len == 0)
            {
                p++;
                break;
            }
            if ((len & 0xC0) == 0xC0)
            {
                if (!jumped) at = p + 2;
                jumped = true;
                p = ((len & 0x3F) << 8) | m[p + 1];
                continue;
            }
            labels.Add(Encoding.ASCII.GetString(m, p + 1, Math.Min(len, m.Length - p - 1)));
            p += len + 1;
        }
        if (!jumped) at = p;
        return string.Join('.', labels).ToLowerInvariant();
    }
}
