using System.Net;
using System.Net.Sockets;

namespace Wolflog.Server.Sources;

/// <summary>Écoute syslog en UDP et/ou TCP (une ligne par message en TCP, ou préfixe de longueur RFC 6587).</summary>
public sealed class SyslogListener(LogSource source, EntrySink sink, SourceStatus status)
{
    public async Task RunAsync(CancellationToken ct)
    {
        var tasks = new List<Task>();
        if (source.Protocol is "udp" or "both") tasks.Add(UdpAsync(ct));
        if (source.Protocol is "tcp" or "both") tasks.Add(TcpAsync(ct));
        status.State = "running";
        status.Detail = $"Écoute sur le port {source.Port} ({(source.Protocol == "both" ? "UDP et TCP" : source.Protocol.ToUpperInvariant())})";
        await Task.WhenAll(tasks);
    }

    private async Task Emit(ParsedEntry e, CancellationToken ct)
    {
        await sink([e], ct);
        status.Entries++;
        status.LastEntryAt = DateTime.UtcNow;
    }

    private async Task UdpAsync(CancellationToken ct)
    {
        using var udp = new UdpClient(new IPEndPoint(IPAddress.Any, source.Port));
        while (!ct.IsCancellationRequested)
        {
            var r = await udp.ReceiveAsync(ct);
            await Emit(SyslogParser.Parse(Encoding.UTF8.GetString(r.Buffer), r.RemoteEndPoint.Address.ToString()), ct);
        }
    }

    private async Task TcpAsync(CancellationToken ct)
    {
        var listener = new TcpListener(IPAddress.Any, source.Port);
        listener.Start();
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(ct);
                _ = Task.Run(() => HandleAsync(client, ct), ct);
            }
        }
        finally
        {
            listener.Stop();
        }
    }

    private async Task HandleAsync(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            var remote = (client.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString();
            using var reader = new StreamReader(client.GetStream(), Encoding.UTF8);
            try
            {
                while (!ct.IsCancellationRequested && await reader.ReadLineAsync(ct) is { } line)
                {
                    // Trame « octet-counting » (RFC 6587) : « 123 <34>1 … ».
                    var sp = line.IndexOf(' ');
                    if (sp > 0 && sp < 7 && line[..sp].All(char.IsDigit) && line.Length > sp + 1 && line[sp + 1] == '<') line = line[(sp + 1)..];
                    if (line.Length > 0) await Emit(SyslogParser.Parse(line, remote), ct);
                }
            }
            catch (IOException) { }
        }
    }
}
