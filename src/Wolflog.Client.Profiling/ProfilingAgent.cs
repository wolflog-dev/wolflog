using System.IO.Compression;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Wolflog.Client.Profiling;

/// <summary>
/// Demande Wolflog toutes les 10 secondes s'il faut profiler cette instance ; si oui, profile et envoie le résultat.
/// Aucun coût tant qu'aucun profil n'est demandé.
/// </summary>
internal sealed class ProfilingAgent(WolflogOptions options, ServiceIdentity identity, ILogger<ProfilingAgent> log) : BackgroundService
{
    private sealed record PendingRequest(string Id, string Kind, int Seconds);
    private sealed record PollResponse(List<PendingRequest> Requests);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>Délais d'interrogation (réduits dans les tests).</summary>
    internal static TimeSpan FirstPoll = TimeSpan.FromSeconds(5);
    internal static TimeSpan PollInterval = TimeSpan.FromSeconds(10);

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (!options.Enabled || string.IsNullOrWhiteSpace(options.Endpoint)) return;
        // Même canal que l'envoi des données (proxy, certificats, tests).
        var handler = options.HttpMessageHandlerFactory?.Invoke() ?? new HttpClientHandler();
        using var http = new HttpClient(handler, disposeHandler: true) { BaseAddress = new Uri(options.Endpoint.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(30) };
        if (!string.IsNullOrEmpty(options.ApiKey)) http.DefaultRequestHeaders.Add("x-wolflog-key", options.ApiKey);
        await Task.Delay(FirstPoll, stop);
        while (!stop.IsCancellationRequested)
        {
            try
            {
                // Hors traces : ces appels techniques ne doivent pas apparaître dans l'application.
                using (OpenTelemetry.SuppressInstrumentationScope.Begin())
                {
                    var url = $"v1/profiling/poll?service={Uri.EscapeDataString(identity.Name)}&instance={identity.InstanceId}" +
                              $"&host={Uri.EscapeDataString(identity.Host)}&version={Uri.EscapeDataString(identity.Version)}&runtime={Uri.EscapeDataString(Environment.Version.ToString())}";
                    var poll = await http.GetFromJsonAsync<PollResponse>(url, Json, stop);
                    foreach (var r in poll?.Requests ?? []) await RunAsync(http, r, stop);
                }
            }
            catch (Exception ex) when (!stop.IsCancellationRequested)
            {
                log.LogDebug(ex, "Wolflog : interrogation du profilage impossible");
            }
            await Task.Delay(PollInterval, stop);
        }
    }

    private async Task RunAsync(HttpClient http, PendingRequest request, CancellationToken stop)
    {
        log.LogInformation("Wolflog : profil {Kind} de {Seconds} s demandé", request.Kind, request.Seconds);
        ProfileResult result;
        string? error = null;
        try
        {
            result = await Profiler.RunAsync(request.Kind, TimeSpan.FromSeconds(Math.Clamp(request.Seconds, 5, 120)), stop);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Ex. EventPipe désactivé (DOTNET_EnableDiagnostics=0) : l'erreur est affichée dans Wolflog.
            error = ex.Message;
            result = new ProfileResult(request.Kind, DateTime.UtcNow, 0, 0, new Dictionary<string, long>());
        }
        var payload = new
        {
            id = request.Id, service = identity.Name, instance = identity.InstanceId, host = identity.Host, version = identity.Version,
            kind = result.Kind, start = result.Start, seconds = result.Seconds, samples = result.Samples, error,
            stacks = result.Stacks.OrderByDescending(kv => kv.Value).Take(20_000).Select(kv => new { s = kv.Key, v = kv.Value }),
        };
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true))
            await JsonSerializer.SerializeAsync(gzip, payload, Json, stop);
        using var content = new ByteArrayContent(buffer.ToArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        content.Headers.ContentEncoding.Add("gzip");
        using var response = await http.PostAsync("v1/profiles", content, stop);
        if (!response.IsSuccessStatusCode) log.LogWarning("Wolflog : envoi du profil refusé ({Status})", (int)response.StatusCode);
    }
}
