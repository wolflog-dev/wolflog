namespace Wolflog.Tests;

public sealed class CapturingHandler : HttpMessageHandler
{
    public System.Collections.Concurrent.ConcurrentQueue<(Uri Url, string Body)> Requests { get; } = new();

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Requests.Enqueue((request.RequestUri!, request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct)));
        return new HttpResponseMessage(HttpStatusCode.OK);
    }
}
