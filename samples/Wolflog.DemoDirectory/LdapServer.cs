using System.Net.Sockets;

namespace Wolflog.DemoDirectory;

/// <summary>Serveur LDAP v3 de démonstration, en clair (sans TLS) : une tâche par connexion, arrêt propre.</summary>
public sealed class LdapServer : IAsyncDisposable
{
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _accepting;

    private LdapServer(InMemoryDirectory directory, TcpListener listener, Action<string> log)
    {
        _listener = listener;
        _accepting = AcceptAsync(directory, log);
    }

    /// <summary>Port d'écoute : utile avec le port 0, choisi par le système (tests).</summary>
    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    public static LdapServer Start(InMemoryDirectory directory, IPAddress address, int port, Action<string>? log = null)
    {
        var listener = new TcpListener(address, port);
        listener.Start();
        return new LdapServer(directory, listener, log ?? (_ => { }));
    }

    private async Task AcceptAsync(InMemoryDirectory directory, Action<string> log)
    {
        while (true)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_stop.Token);
            }
            catch (Exception ex) when (ex is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                return;
            }
            _ = ServeAsync(client, directory, log);
        }
    }

    private async Task ServeAsync(TcpClient client, InMemoryDirectory directory, Action<string> log)
    {
        using (client)
        {
            try
            {
                await new LdapSession(directory, client.GetStream(), log).RunAsync(_stop.Token);
            }
            catch (Exception ex) when (ex is IOException or SocketException or AsnContentException or OperationCanceledException or ObjectDisposedException)
            {
                // Connexion coupée par le client ou message illisible : la connexion est simplement fermée.
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _listener.Stop();
        await _accepting;
        _stop.Dispose();
    }
}
