using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;

namespace Wolflog.DemoDirectory;

/// <summary>
/// Serveur LDAP v3 de démonstration : en clair, ou en LDAPS (TLS dès la connexion) avec le certificat fourni. Une tâche par
/// connexion, arrêt propre.
/// </summary>
public sealed class LdapServer : IAsyncDisposable
{
    private readonly TcpListener _listener;
    private readonly X509Certificate2? _certificate;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _accepting;

    private LdapServer(InMemoryDirectory directory, TcpListener listener, Action<string> log, X509Certificate2? certificate)
    {
        _listener = listener;
        _certificate = certificate;
        _accepting = AcceptAsync(directory, log);
    }

    /// <summary>Port d'écoute : utile avec le port 0, choisi par le système (tests).</summary>
    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    /// <summary>Démarre l'écoute ; avec un certificat (et sa clé privée), les connexions sont en LDAPS.</summary>
    public static LdapServer Start(InMemoryDirectory directory, IPAddress address, int port, Action<string>? log = null, X509Certificate2? certificate = null)
    {
        var listener = new TcpListener(address, port);
        listener.Start();
        return new LdapServer(directory, listener, log ?? (_ => { }), certificate);
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
                Stream stream = client.GetStream();
                if (_certificate is not null)
                {
                    var tls = new SslStream(stream);
                    await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = _certificate }, _stop.Token);
                    stream = tls;
                }
                await using (stream) await new LdapSession(directory, stream, log).RunAsync(_stop.Token);
            }
            catch (Exception ex) when (ex is IOException or SocketException or AsnContentException or OperationCanceledException or ObjectDisposedException or AuthenticationException)
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
