using Serilog;

var builder = WebApplication.CreateBuilder(args);

// 1. Une ligne pour envoyer logs, traces, métriques et crashs à Wolflog (config : section "Wolflog").
builder.AddWolflog();
// Profilage CPU / mémoire à la demande depuis Wolflog (paquet Wolflog.Client.Profiling).
builder.AddWolflogProfiling();

// 2. Serilog, comme dans une application existante : .WriteTo.Wolflog() suffit.
builder.Services.AddSerilog((services, log) => log
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Wolflog(services));

builder.Services.AddHttpClient("self", (sp, c) =>
    c.BaseAddress = new Uri(sp.GetRequiredService<IConfiguration>()["Urls"]!.Split(';')[0]));
// Carte des services : Demo:StockUrl pointe vers une seconde instance (ex. Wolflog:ServiceName=stock-api).
builder.Services.AddHttpClient("stock", (sp, c) =>
{
    var config = sp.GetRequiredService<IConfiguration>();
    c.BaseAddress = new Uri(config["Demo:StockUrl"] is { Length: > 0 } url ? url : config["Urls"]!.Split(';')[0]);
});
builder.Services.AddHostedService<TrafficGenerator>();
builder.Services.AddHostedService<BrowserSimulator>();

var app = builder.Build();

app.MapGet("/", () => "Wolflog demo : /boutique (suivi navigateur), /api/orders/42, /api/fail, /api/crash, /api/failfast");
app.MapShop();
app.MapBrowserDemo();

app.MapGet("/api/orders/{id:int}", async (int id, IHttpClientFactory http, ILogger<Program> log) =>
{
    using var activity = Telemetry.Source.StartActivity("ComputePrice");
    activity?.SetTag("order.id", id);
    await Task.Delay(Random.Shared.Next(5, 60));

    await Telemetry.Query("SELECT * FROM orders WHERE id = @id", 3, 25);
    var stock = await http.CreateClient("stock").GetStringAsync($"/api/stock/{id}");
    var amount = Math.Round(Random.Shared.NextDouble() * 200, 2);
    Telemetry.Orders.Add(1, new KeyValuePair<string, object?>("channel", id % 2 == 0 ? "web" : "mobile"));
    Telemetry.Amount.Record(amount);

    log.LogInformation("Commande {OrderId} calculée : {Amount} € (stock {Stock})", id, amount, stock);
    return Results.Ok(new { id, amount, stock });
});

app.MapGet("/api/stock/{id:int}", async (int id, ILogger<Program> log) =>
{
    await Telemetry.Query("SELECT quantity FROM stock WHERE product_id = @id", 1, 20);
    var stock = Random.Shared.Next(0, 50);
    if (stock < 5) log.LogWarning("Stock faible pour le produit {ProductId} : {Stock}", id, stock);
    return stock;
});

// Corps JSON : visible dans Wolflog (Requêtes HTTP > détail), numéro de carte masqué.
app.MapPost("/api/payments", (PaymentRequest payment, ILogger<Program> log) =>
{
    // Appel à un prestataire de paiement (simulé : aucune requête réseau réelle).
    using (var psp = Telemetry.Source.StartActivity("POST api.paiement-exemple.fr/v1/charges", ActivityKind.Client))
    {
        psp?.SetTag("http.request.method", "POST");
        psp?.SetTag("server.address", "api.paiement-exemple.fr");
        psp?.SetTag("url.full", "https://api.paiement-exemple.fr/v1/charges");
        Thread.Sleep(Random.Shared.Next(40, 160));
        var declined = Random.Shared.Next(20) == 0;
        psp?.SetTag("http.response.status_code", declined ? 503 : 200);
        if (declined) psp?.SetStatus(ActivityStatusCode.Error, "Prestataire indisponible");
    }
    if (payment.Amount > 150)
    {
        log.LogWarning("Paiement refusé pour la commande {OrderId} : {Amount} €", payment.OrderId, payment.Amount);
        return Results.Problem($"Plafond dépassé ({payment.Amount} € > 150 €)", statusCode: 402, title: "Paiement refusé");
    }
    return Results.Ok(new { payment.OrderId, status = "accepté", reference = Guid.NewGuid() });
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
