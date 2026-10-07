namespace Wolflog.Tests;

/// <summary>
/// Faux serveur Wolflog : note chaque requête reçue (méthode, adresse, en-tête Authorization) et répond le statut choisi, sans
/// corps ; Down simule un serveur arrêté (connexion refusée).
/// </summary>
public sealed class RecordingHandler : HttpMessageHandler
{
    private int _calls;

    public List<(HttpMethod Method, Uri Url, string? Authorization)> Requests { get; } = [];
    public HttpStatusCode Status { get; set; } = HttpStatusCode.Accepted;
    public bool Down { get; set; }

    /// <summary>Appels reçus, y compris pendant un arrêt.</summary>
    public int Calls => Volatile.Read(ref _calls);

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _calls);
        if (Down) throw new HttpRequestException("Connexion refusée : Wolflog arrêté.");
        lock (Requests) Requests.Add((request.Method, request.RequestUri!, request.Headers.Authorization?.ToString()));
        return Task.FromResult(new HttpResponseMessage(Status) { Content = new ByteArrayContent([]) });
    }
}
