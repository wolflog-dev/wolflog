using System.Net.Http.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;

namespace Wolflog.Client.Blazor;

/// <summary>
/// File d'envoi en arrière-plan vers /v1/analytics : la mesure n'ajoute aucune latence aux composants,
/// et une indisponibilité de Wolflog n'a aucun effet sur l'application (les événements sont alors abandonnés).
/// </summary>
internal sealed class AnalyticsSender(IHttpClientFactory http, IOptions<WolflogBlazorOptions> options, ILogger<AnalyticsSender> log) : BackgroundService
{
    private readonly Channel<AnalyticsEvent> _channel = Channel.CreateBounded<AnalyticsEvent>(new BoundedChannelOptions(10_000)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
    });

    public bool Enabled => options.Value is { Enabled: true, Endpoint.Length: > 0 };

    public void Enqueue(AnalyticsEvent e)
    {
        if (Enabled) _channel.Writer.TryWrite(e);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var o = options.Value;
        if (!Enabled) return;
        var client = http.CreateClient(WolflogBlazorExtensions.HttpClientName);
        var url = o.Endpoint!.TrimEnd('/') + "/v1/analytics";
        var batch = new List<AnalyticsEvent>(256);
        while (await _channel.Reader.WaitToReadAsync(stoppingToken).ConfigureAwait(false))
        {
            // Regroupe les événements arrivés pendant l'intervalle : une requête par lot.
            await Task.Delay(o.FlushInterval, stoppingToken).ConfigureAwait(false);
            while (batch.Count < 1000 && _channel.Reader.TryRead(out var e)) batch.Add(e);
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, url)
                {
                    Content = JsonContent.Create(new { service = o.ServiceName, env = o.Environment, events = batch }),
                };
                if (!string.IsNullOrEmpty(o.ApiKey)) request.Headers.Add("x-wolflog-key", o.ApiKey);
                using var response = await client.SendAsync(request, stoppingToken).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) log.LogDebug("Wolflog a refusé l'audience : {Status}", (int)response.StatusCode);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !stoppingToken.IsCancellationRequested)
            {
                log.LogDebug(ex, "Envoi de l'audience à Wolflog impossible");
            }
            batch.Clear();
        }
    }
}
