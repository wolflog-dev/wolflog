/// <summary>Génère un peu de trafic pour remplir Wolflog.</summary>
internal sealed class TrafficGenerator(IHttpClientFactory http, IConfiguration config, ILogger<TrafficGenerator> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("Demo:Traffic", true)) return;
        await Task.Delay(2000, stoppingToken);
        var client = http.CreateClient("self");
        var i = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (++i % 25 == 0) await client.GetAsync("/api/fail", stoppingToken);
                else if (i % 7 == 0) await Search(client, stoppingToken);
                else if (i % 11 == 0)
                    await client.PutAsJsonAsync($"/api/customers/{Random.Shared.Next(1, 9999)}", Fake.Customer(Random.Shared, valid: Random.Shared.Next(2) == 0), stoppingToken);
                else if (i % 17 == 0)
                    await client.GetAsync("/api/reports/sales?from=2026-01-01&to=2026-09-24&groupBy=region&include=products,returns&currency=EUR", stoppingToken);
                else if (i % 4 == 0)
                    await client.PostAsJsonAsync("/api/payments", new PaymentRequest(i, Math.Round(Random.Shared.NextDouble() * 200, 2), "4970101234567890", "123"), stoppingToken);
                else await client.GetAsync($"/api/orders/{Random.Shared.Next(1, 500)}", stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Erreur du générateur de trafic");
            }
            await Task.Delay(Random.Shared.Next(200, 800), stoppingToken);
        }
    }

    /// <summary>Requête "complexe" : paramètres multiples, en-têtes, corps JSON imbriqué.</summary>
    private static async Task Search(HttpClient client, CancellationToken ct)
    {
        var page = Random.Shared.Next(1, 20);
        var request = new HttpRequestMessage(HttpMethod.Post,
            $"/api/orders/search?page={page}&pageSize=25&sort=-createdAt&status=paid&status=shipped&include=customer,items,history&currency=EUR&access_token=demo-secret-123");
        request.Headers.Add("X-Correlation-Id", Guid.NewGuid().ToString());
        request.Headers.Add("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "eyJhbGciOiJIUzI1NiJ9.demo.signature");
        request.Content = JsonContent.Create(Fake.Search(Random.Shared));
        using var _ = await client.SendAsync(request, ct);
    }
}
