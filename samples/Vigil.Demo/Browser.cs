using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Cryptography;

/// <summary>
/// Page de démonstration du suivi navigateur (/boutique) et visiteurs simulés : ils envoient ce que
/// vigil-rum.js enverrait (pages, Web Vitals, erreurs JavaScript) et appellent vraiment l'API avec un en-tête
/// traceparent, pour relier le navigateur aux traces du serveur.
/// </summary>
internal static class BrowserDemo
{
    public static void MapBrowserDemo(this WebApplication app)
    {
        app.MapGet("/boutique", (IConfiguration config) =>
        {
            var endpoint = (config["Vigil:Endpoint"] ?? "http://localhost:5080").TrimEnd('/');
            var key = config["Vigil:BrowserKey"] is { Length: > 0 } k ? k : config["Vigil:ApiKey"] ?? "";
            var html = $$"""
                <!doctype html>
                <html lang="fr"><head><meta charset="utf-8"><title>Boutique (démo Vigil)</title>
                <script src="{{endpoint}}/vigil-rum.js" defer data-key="{{key}}" data-service="boutique-web" data-env="démo"></script>
                <style>body{font:15px system-ui;margin:40px;max-width:640px}button{margin:4px 8px 4px 0;padding:6px 12px}pre{background:#f4f4f4;padding:10px}</style>
                </head><body>
                <h1>Boutique</h1>
                <p>Page instrumentée par <code>vigil-rum.js</code> : chaque action ci-dessous apparaît dans Vigil
                (tableau « Expérience navigateur », Erreurs, Requêtes HTTP sortantes de boutique-web, Carte des services).</p>
                <button onclick="load(42)">Charger la commande 42</button>
                <button onclick="load(Math.floor(Math.random()*500))">Commande au hasard</button>
                <button onclick="fetch('/api/fail').then(r=>show('Statut '+r.status))">Appel en erreur (500)</button>
                <button onclick="panier.total()">Erreur JavaScript</button>
                <button onclick="history.pushState({}, '', '/boutique/panier'); show('Route : /boutique/panier')">Changer de route</button>
                <pre id="out">…</pre>
                <script>
                  const panier = {};
                  function show(t){ document.getElementById('out').textContent = t; }
                  function load(id){ fetch('/api/orders/' + id).then(r => r.json()).then(j => show(JSON.stringify(j, null, 2))); }
                </script>
                </body></html>
                """;
            return Results.Content(html, "text/html; charset=utf-8");
        });
    }
}

/// <summary>Visiteurs simulés : une visite toutes les quelques secondes.</summary>
internal sealed class BrowserSimulator(IHttpClientFactory http, IConfiguration config, ILogger<BrowserSimulator> log) : BackgroundService
{
    private static readonly string[] Pages = ["/", "/catalogue", "/produit/{id}", "/panier", "/commande"];
    private static readonly string[] Agents =
    [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
    ];

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (!config.GetValue("Demo:Traffic", true) || !config.GetValue("Demo:Browser", true)) return;
        var endpoint = (config["Vigil:Endpoint"] ?? "http://localhost:5080").TrimEnd('/');
        var key = config["Vigil:BrowserKey"] is { Length: > 0 } k ? k : config["Vigil:ApiKey"] ?? "";
        // Clients hors instrumentation : le « navigateur » pose lui-même son en-tête traceparent.
        var vigil = new HttpClient(new SocketsHttpHandler { ActivityHeadersPropagator = null }) { BaseAddress = new Uri(endpoint + "/"), Timeout = TimeSpan.FromSeconds(10) };
        var api = new HttpClient(new SocketsHttpHandler { ActivityHeadersPropagator = null })
        {
            BaseAddress = http.CreateClient("self").BaseAddress, Timeout = TimeSpan.FromSeconds(10),
        };
        await Task.Delay(3000, stop);
        while (!stop.IsCancellationRequested)
        {
            try
            {
                using (OpenTelemetry.SuppressInstrumentationScope.Begin()) await Visit(vigil, api, key, stop);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !stop.IsCancellationRequested)
            {
                log.LogDebug(ex, "Visite simulée");
            }
            await Task.Delay(Random.Shared.Next(1500, 4000), stop);
        }
    }

    private static async Task Visit(HttpClient vigil, HttpClient api, string key, CancellationToken ct)
    {
        var r = Random.Shared;
        var page = Pages[r.Next(Pages.Length)].Replace("{id}", r.Next(1, 300).ToString());
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var slow = page.StartsWith("/catalogue") ? 1.8 : 1.0; // une page nettement plus lente que les autres
        var events = new List<object>
        {
            new { type = "page", ts = now, path = page, duration = Math.Round((600 + r.NextDouble() * 1400) * slow), ttfb = Math.Round(40 + r.NextDouble() * 200), domReady = 500.0, nav = "navigate" },
            new { type = "vital", ts = now, path = page, name = "lcp", value = Math.Round((900 + r.NextDouble() * 2200) * slow) },
            new { type = "vital", ts = now, path = page, name = "fcp", value = Math.Round(300 + r.NextDouble() * 900) },
            new { type = "vital", ts = now, path = page, name = "inp", value = Math.Round(40 + r.NextDouble() * (r.Next(10) == 0 ? 600 : 160)) },
            new { type = "vital", ts = now, path = page, name = "cls", value = Math.Round(r.NextDouble() * (r.Next(6) == 0 ? 0.3 : 0.06), 3) },
        };

        // Appel réel à l'API avec un en-tête traceparent : la trace du serveur prolonge celle du navigateur.
        if (page is "/panier" or "/commande" || page.StartsWith("/produit"))
        {
            var trace = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            var span = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
            var url = page == "/commande" && r.Next(8) == 0 ? "/api/fail" : $"/api/orders/{r.Next(1, 500)}";
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("traceparent", $"00-{trace}-{span}-01");
            var sw = Stopwatch.StartNew();
            using var response = await api.SendAsync(request, ct);
            var status = (int)response.StatusCode;
            events.Add(new { type = "fetch", ts = now, path = page, method = "GET", url = api.BaseAddress + url.TrimStart('/'), host = api.BaseAddress!.Authority,
                status, duration = sw.Elapsed.TotalMilliseconds, trace, span });
        }

        if (r.Next(12) == 0)
            events.Add(new { type = "error", ts = now, path = page, name = "TypeError", message = "Cannot read properties of undefined (reading 'prix')",
                stack = "TypeError: Cannot read properties of undefined (reading 'prix')\n    at total (https://boutique.exemple.fr/assets/app.js:1:48213)\n    at HTMLButtonElement.onclick (https://boutique.exemple.fr/panier:12:31)" });
        if (r.Next(25) == 0)
            events.Add(new { type = "error", ts = now, path = page, name = "ResourceError", message = "Échec du chargement de https://cdn.exemple.fr/images/produit.webp" });

        var batch = new { service = "boutique-web", env = "démo", session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4)), ua = Agents[r.Next(Agents.Length)], events };
        using var send = new HttpRequestMessage(HttpMethod.Post, $"v1/rum?k={Uri.EscapeDataString(key)}") { Content = JsonContent.Create(batch) };
        send.Headers.Add("Origin", "https://boutique.exemple.fr");
        using var _ = await vigil.SendAsync(send, ct);
    }
}
