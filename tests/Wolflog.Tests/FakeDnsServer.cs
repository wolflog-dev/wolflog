using System.Buffers.Binary;
using System.Globalization;
using System.Net.Sockets;

namespace Wolflog.Tests;

/// <summary>Serveur DNS minimal sur 127.0.0.1 (UDP) : enregistrements MX, TXT et SRV déclarés par le test.</summary>
public sealed class FakeDnsServer : IDisposable
{
    private readonly UdpClient _udp = new(new IPEndPoint(IPAddress.Loopback, 0));
    private readonly CancellationTokenSource _stop = new();

    /// <summary>(nom, type) → enregistrements : MX « 10 hôte », TXT « texte », SRV « 0 1 587 hôte ».</summary>
    public Dictionary<(string Name, int Type), List<string>> Records { get; } = [];

    public IPEndPoint EndPoint => (IPEndPoint)_udp.Client.LocalEndPoint!;

    public FakeDnsServer() => _ = ServeAsync();

    private async Task ServeAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            UdpReceiveResult request;
            try { request = await _udp.ReceiveAsync(_stop.Token); }
            catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or SocketException) { return; }
            var q = request.Buffer;
            var at = 12;
            var labels = new List<string>();
            while (q[at] != 0)
            {
                labels.Add(Encoding.ASCII.GetString(q, at + 1, q[at]));
                at += q[at] + 1;
            }
            var questionEnd = at + 5;
            var name = string.Join('.', labels).ToLowerInvariant();
            var type = BinaryPrimitives.ReadUInt16BigEndian(q.AsSpan(at + 1));

            var answers = Records.TryGetValue((name, type), out var values) ? values : [];
            var response = new List<byte>(q[..questionEnd]);
            response[2] = 0x81; // QR, RD
            response[3] = (byte)(answers.Count == 0 && !Records.Keys.Any(k => k.Name == name) ? 0x83 : 0x80); // NXDOMAIN si le nom est inconnu
            response[6] = 0;
            response[7] = (byte)answers.Count;
            response[10] = response[11] = 0; // pas d'enregistrement additionnel
            foreach (var value in answers)
            {
                response.AddRange([0xC0, 0x0C]); // nom : pointeur vers la question
                U16(response, type);
                U16(response, 1);
                response.AddRange([0, 0, 1, 0]); // TTL
                var data = new List<byte>();
                var parts = value.Split(' ');
                switch (type)
                {
                    case 15:
                        U16(data, int.Parse(parts[0], CultureInfo.InvariantCulture));
                        Name(data, parts[1]);
                        break;
                    case 33:
                        U16(data, int.Parse(parts[0], CultureInfo.InvariantCulture));
                        U16(data, int.Parse(parts[1], CultureInfo.InvariantCulture));
                        U16(data, int.Parse(parts[2], CultureInfo.InvariantCulture));
                        Name(data, parts[3]);
                        break;
                    default:
                        // Texte en morceaux de 40 octets, comme un long SPF.
                        var bytes = Encoding.UTF8.GetBytes(value);
                        for (var i = 0; i < bytes.Length; i += 40)
                        {
                            var chunk = bytes[i..Math.Min(bytes.Length, i + 40)];
                            data.Add((byte)chunk.Length);
                            data.AddRange(chunk);
                        }
                        break;
                }
                U16(response, data.Count);
                response.AddRange(data);
            }
            var datagram = response.ToArray();
            await _udp.SendAsync(datagram, datagram.Length, request.RemoteEndPoint);
        }
    }

    private static void U16(List<byte> b, int v)
    {
        b.Add((byte)(v >> 8));
        b.Add((byte)v);
    }

    private static void Name(List<byte> b, string name)
    {
        foreach (var label in name.Split('.'))
        {
            b.Add((byte)label.Length);
            b.AddRange(Encoding.ASCII.GetBytes(label));
        }
        b.Add(0);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _udp.Dispose();
    }
}
