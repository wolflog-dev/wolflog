using System.Diagnostics;
using System.Diagnostics.Metrics;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// 1. Une ligne pour envoyer logs, traces, métriques et crashs à Vigil (config : section "Vigil").
builder.AddVigil();

// 2. Serilog, comme dans une application existante : .WriteTo.Vigil() suffit.
builder.Services.AddSerilog((services, log) => log
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Vigil(services));

builder.Services.AddHttpClient("self", (sp, c) =>
    c.BaseAddress = new Uri(sp.GetRequiredService<IConfiguration>()["Urls"]!.Split(';')[0]));
builder.Services.AddHostedService<TrafficGenerator>();

var app = builder.Build();

app.MapGet("/", () => "Vigil demo : /api/orders/42, /api/fail, /api/crash, /api/failfast");

app.MapGet("/api/orders/{id:int}", async (int id, IHttpClientFactory http, ILogger<Program> log) =>
{
    using var activity = Telemetry.Source.StartActivity("ComputePrice");
    activity?.SetTag("order.id", id);
    await Task.Delay(Random.Shared.Next(5, 60));

    var stock = await http.CreateClient("self").GetStringAsync($"/api/stock/{id}");
    var amount = Math.Round(Random.Shared.NextDouble() * 200, 2);
    Telemetry.Orders.Add(1, new KeyValuePair<string, object?>("channel", id % 2 == 0 ? "web" : "mobile"));
    Telemetry.Amount.Record(amount);

    log.LogInformation("Commande {OrderId} calculée : {Amount} € (stock {Stock})", id, amount, stock);
    return Results.Ok(new { id, amount, stock });
});

app.MapGet("/api/stock/{id:int}", async (int id, ILogger<Program> log) =>
{
    await Task.Delay(Random.Shared.Next(1, 30));
    var stock = Random.Shared.Next(0, 50);
    if (stock < 5) log.LogWarning("Stock faible pour le produit {ProductId} : {Stock}", id, stock);
    return stock;
});

app.MapGet("/api/fail", (ILogger<Program> log) =>
{
    log.LogInformation("Chargement du client {CustomerId}", Random.Shared.Next(1000, 9999));
    throw new InvalidOperationException($"Client introuvable (id={Random.Shared.Next(1, 100)})");
});

// Exception sur un thread hors requête : le processus s'arrête → rapport de crash.
app.MapGet("/api/crash", () =>
{
    Log.Warning("Crash volontaire demandé");
    new Thread(() => throw new ApplicationException("Crash volontaire de la démo")).Start();
    return "Le processus va s'arrêter.";
});

// Arrêt brutal sans exception gérable : détecté au redémarrage suivant (comme un StackOverflow).
app.MapGet("/api/failfast", () =>
{
    Log.Warning("Arrêt brutal demandé");
    Environment.FailFast("Arrêt brutal de la démo");
    return "";
});

app.Run();

internal static class Telemetry
{
    public static readonly ActivitySource Source = new("Vigil.Demo");
    public static readonly Meter Meter = new("Vigil.Demo");
    public static readonly Counter<long> Orders = Meter.CreateCounter<long>("demo.orders", description: "Commandes calculées");
    public static readonly Histogram<double> Amount = Meter.CreateHistogram<double>("demo.order.amount", unit: "EUR");
}

/// <summary>Génère un peu de trafic pour remplir Vigil.</summary>
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
                else await client.GetAsync($"/api/orders/{Random.Shared.Next(1, 500)}", stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Erreur du générateur de trafic");
            }
            await Task.Delay(Random.Shared.Next(200, 800), stoppingToken);
        }
    }
}
