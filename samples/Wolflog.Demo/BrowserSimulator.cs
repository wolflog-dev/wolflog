using System.Security.Cryptography;

/// <summary>Visiteurs simulés : une visite toutes les quelques secondes.</summary>
internal sealed class BrowserSimulator(IHttpClientFactory http, IConfiguration config, ILogger<BrowserSimulator> log) : BackgroundService
{
    private static readonly string[] Pages = ["/boutique", "/boutique/catalogue", "/boutique/produit/{id}", "/boutique/panier", "/boutique/commande"];
    private static readonly string[] Agents =
    [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
    ];

    // Audience simulée : sources, campagnes, langues, événements, clics et défilement sur les vraies pages de /boutique.
    private static readonly Dictionary<string, string> Titles = new()
    {
        ["/boutique"] = "Accueil  Boutique", ["/boutique/catalogue"] = "Catalogue  Boutique", ["/boutique/produit"] = "Fiche produit  Boutique",
        ["/boutique/panier"] = "Panier  Boutique", ["/boutique/commande"] = "Commande  Boutique",
    };
    private static readonly (string? Value, int Weight)[] Referrers =
        [(null, 45), ("https://www.google.com/", 25), ("https://www.bing.com/", 4), ("https://www.linkedin.com/", 6), ("https://news.ycombinator.com/", 5), ("https://www.facebook.com/", 5)];
    private static readonly (string? Value, int Weight)[] Campaigns =
        [(null, 80), ("?utm_source=newsletter&utm_medium=email&utm_campaign=rentree", 10), ("?utm_source=google&utm_medium=cpc&utm_campaign=marque", 6), ("?utm_source=instagram&utm_medium=social", 4)];
    private static readonly (string? Value, int Weight)[] Languages = [("fr-FR", 60), ("fr-BE", 12), ("fr-CA", 8), ("fr-CH", 6), ("en-US", 9), ("de-DE", 5)];
    private static readonly string[] ProductNames = ["Lampe Oslo", "Fauteuil Nara", "Vase Bora", "Tapis Sahel", "Miroir Lina", "Chaise Tove", "Plaid Isla", "Étagère Ren"];

    /// <summary>Élément d'une page de /boutique mesuré à 1280 px : position (fraction de la largeur, px), taille, attractivité.</summary>
    private sealed record Element(string Selector, string? Label, double X, int Y, double W, int H, int Weight, bool Dead = false, double Rage = 0);

    private sealed record PageLayout(int DocHeight, Element[] Elements);

    private static Element[] Header(bool scrollbar) => scrollbar
        ?
        [
            new("header > div.wrap.barre > a.logo:nth-of-type(1)", "Maison Nord", 0.0763, 21, 0.0887, 29, 3),
            new("header > div.wrap.barre > nav > a:nth-of-type(1)", "Catalogue", 0.7102, 24, 0.0531, 23, 10),
            new("header > div.wrap.barre > nav > a:nth-of-type(2)", "Promotions", 0.7823, 24, 0.0605, 23, 6),
            new("header > div.wrap.barre > a.panier:nth-of-type(2)", "Panier", 0.8649, 16, 0.0588, 39, 7),
        ]
        :
        [
            new("header > div.wrap.barre > a.logo:nth-of-type(1)", "Maison Nord", 0.0813, 21, 0.0877, 29, 3),
            new("header > div.wrap.barre > nav > a:nth-of-type(1)", "Catalogue", 0.7078, 24, 0.0525, 23, 10),
            new("header > div.wrap.barre > nav > a:nth-of-type(2)", "Promotions", 0.779, 24, 0.0598, 23, 6),
            new("header > div.wrap.barre > a.panier:nth-of-type(2)", "Panier", 0.8607, 16, 0.0581, 39, 7),
        ];

    private static Element[] Footer(int y, bool scrollbar) =>
    [
        new("footer.wrap > a:nth-of-type(1)", "Maison Nord", scrollbar ? 0.0763 : 0.0813, y, 0.068, 23, 1),
        new("footer.wrap > a:nth-of-type(3)", "Atelier Wolflog", scrollbar ? 0.2358 : 0.2389, y, 0.078, 23, 1),
    ];

    /// <summary>Rangée de 4 cartes produit : image (lien) et bouton « Ajouter au panier », légèrement lent (rage clicks).</summary>
    private static IEnumerable<Element> Cards(string grid, int firstCard, int firstProduct, int y, int weight)
    {
        double[] columns = [0.0881, 0.304, 0.5198, 0.7356];
        for (var c = 0; c < 4; c++)
        {
            var card = $"{grid} > article.carte:nth-of-type({firstCard + c})";
            yield return new($"{card} > a > div.img", ProductNames[firstProduct + c], columns[c], y, 0.1763, 180, weight);
            yield return new($"{card} > button.ajouter", "Ajouter au panier", columns[c], y + 252, 0.1063, 35, weight + 2, Rage: 0.12);
        }
    }

    private static readonly Dictionary<string, PageLayout> Layouts = new()
    {
        ["/boutique"] = new(1453,
        [
            .. Header(true),
            new("main.wrap > section.hero:nth-of-type(1) > h1", null, 0.0763, 144, 0.4901, 101, 3, Dead: true),
            new("main.wrap > section.hero:nth-of-type(1) > a.cta", "Voir les nouveautés", 0.0763, 316, 0.1454, 48, 28),
            .. Cards("main.wrap > div.grid:nth-of-type(1)", 1, 0, 443, 5),
            // Les avantages ressemblent à des liens : clics sans effet (dead clicks).
            new("main.wrap > section.bandeau:nth-of-type(2) > div:nth-of-type(1)", null, 0.1087, 842, 0.2398, 61, 5, Dead: true),
            new("main.wrap > section.bandeau:nth-of-type(2) > div:nth-of-type(2)", null, 0.3801, 842, 0.2398, 61, 3, Dead: true),
            new("main.wrap > section.bandeau:nth-of-type(2) > div:nth-of-type(3)", null, 0.6515, 842, 0.2398, 61, 2, Dead: true),
            .. Cards("main.wrap > div.grid:nth-of-type(2)", 1, 4, 1071, 2),
            .. Footer(1430, true),
        ]),
        ["/boutique/catalogue"] = new(919,
        [
            .. Header(true),
            new("main.wrap > h1.titre", null, 0.0763, 112, 0.8474, 48, 1, Dead: true),
            .. Cards("main.wrap > div.grid", 1, 0, 199, 6),
            .. Cards("main.wrap > div.grid", 5, 4, 537, 4),
            .. Footer(896, true),
        ]),
        ["/boutique/produit"] = new(900,
        [
            .. Header(false),
            // Les visiteurs cliquent sur la photo pour l'agrandir, sans effet : le dead click le plus fréquent.
            new("main.wrap > div.fiche > div.img:nth-of-type(1)", null, 0.0813, 112, 0.4, 440, 18, Dead: true),
            new("main.wrap > div.fiche > div:nth-of-type(2) > h1", null, 0.5188, 112, 0.4, 54, 2, Dead: true),
            new("main.wrap > div.fiche > div:nth-of-type(2) > button.ajouter", "Ajouter au panier", 0.5188, 300, 0.133, 48, 30, Rage: 0.2),
            .. Footer(617, false),
        ]),
        ["/boutique/panier"] = new(900,
        [
            .. Header(false),
            new("main.wrap > h1.titre", null, 0.0813, 112, 0.8375, 48, 1, Dead: true),
            new("main.wrap > div.total:nth-of-type(3) > a.cta", "Commander", 0.8125, 424, 0.1062, 48, 35),
            .. Footer(537, false),
        ]),
        ["/boutique/commande"] = new(900,
        [
            .. Header(false),
            new("main.wrap > form > label:nth-of-type(1) > input", null, 0.0813, 211, 0.4063, 44, 10),
            new("main.wrap > form > label:nth-of-type(2) > input", null, 0.0813, 296, 0.4063, 44, 9),
            new("main.wrap > form > label:nth-of-type(3) > input", null, 0.0813, 381, 0.4063, 44, 9),
            // Le paiement répond lentement : une partie des visiteurs clique plusieurs fois (rage clicks).
            new("main.wrap > button.payer", "Payer 348 €", 0.0813, 453, 0.1024, 48, 30, Rage: 0.3),
            .. Footer(582, false),
        ]),
    };

    private static T Pick<T>(Random r, (T Value, int Weight)[] items)
    {
        var x = r.Next(items.Sum(i => i.Weight));
        foreach (var (value, weight) in items)
            if ((x -= weight) < 0) return value;
        return items[0].Value;
    }

    private static void AddAudience(List<object> events, Random r, string page, long now)
    {
        const int vw = 1280, vh = 900;
        var layout = Layouts[page.StartsWith("/boutique/produit") ? "/boutique/produit" : page];
        var clicks = r.Next(1, 4);
        var t = now + 500;
        for (var i = 0; i < clicks; i++)
        {
            var el = Pick(r, layout.Elements.Select(e => (e, e.Weight)).ToArray());
            var x = Math.Round(el.X + el.W * (0.15 + r.NextDouble() * 0.7), 4);
            var y = el.Y + (int)(el.H * (0.2 + r.NextDouble() * 0.6));
            var repeats = r.NextDouble() < el.Rage ? 3 + r.Next(3) : 1;
            for (var k = 0; k < repeats; k++)
            {
                events.Add(new { type = "click", ts = t, path = page, x = x + r.Next(-3, 4) / 10000.0, y = y + r.Next(-3, 4), selector = el.Selector,
                    label = el.Label, rage = k >= 2, dead = el.Dead, vw, vh, dh = layout.DocHeight });
                t += 180;
            }
            if (el.Label == "Ajouter au panier")
                events.Add(new { type = "track", ts = t, path = page, name = "ajout-panier", data = new { produit = r.Next(1, 9) } });
            if (el.Label?.StartsWith("Payer", StringComparison.Ordinal) == true)
                events.Add(new { type = "track", ts = t, path = page, name = "commande", data = new { revenue = Math.Round(39 + r.NextDouble() * 400, 2), currency = "EUR" } });
            t += 900;
        }
        var fold = Math.Min(100.0, vh * 100.0 / layout.DocHeight);
        var depth = (int)Math.Min(100, fold + (100 - fold) * Math.Pow(r.NextDouble(), 1.4));
        events.Add(new { type = "scroll", ts = t + 2000, path = page, depth, vw, vh, dh = layout.DocHeight });
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (!config.GetValue("Demo:Traffic", true) || !config.GetValue("Demo:Browser", true)) return;
        var endpoint = (config["Wolflog:Endpoint"] ?? "http://localhost:5080").TrimEnd('/');
        // Adresse réelle de la boutique : l'aperçu des cartes de chaleur affiche ses pages.
        var host = new Uri((config["Urls"] ?? "http://localhost:5190").Split(';')[0].Replace("*", "localhost").Replace("0.0.0.0", "localhost")).Authority;
        var key = config["Wolflog:BrowserKey"] is { Length: > 0 } k ? k : config["Wolflog:ApiKey"] ?? "";
        // Clients hors instrumentation : le « navigateur » pose lui-même son en-tête traceparent.
        var wolflog = new HttpClient(new SocketsHttpHandler { ActivityHeadersPropagator = null }) { BaseAddress = new Uri(endpoint + "/"), Timeout = TimeSpan.FromSeconds(10) };
        var api = new HttpClient(new SocketsHttpHandler { ActivityHeadersPropagator = null })
        {
            BaseAddress = http.CreateClient("self").BaseAddress, Timeout = TimeSpan.FromSeconds(10),
        };
        await Task.Delay(3000, stop);
        while (!stop.IsCancellationRequested)
        {
            try
            {
                using (OpenTelemetry.SuppressInstrumentationScope.Begin()) await Visit(wolflog, api, key, host, stop);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !stop.IsCancellationRequested)
            {
                log.LogDebug(ex, "Visite simulée");
            }
            await Task.Delay(Random.Shared.Next(1500, 4000), stop);
        }
    }

    private static async Task Visit(HttpClient wolflog, HttpClient api, string key, string host, CancellationToken ct)
    {
        var r = Random.Shared;
        var page = Pages[r.Next(Pages.Length)].Replace("{id}", r.Next(1, 9).ToString());
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var slow = page.StartsWith("/boutique/catalogue") ? 1.8 : 1.0; // une page nettement plus lente que les autres
        var events = new List<object>
        {
            new { type = "page", ts = now, path = page, duration = Math.Round((600 + r.NextDouble() * 1400) * slow), ttfb = Math.Round(40 + r.NextDouble() * 200), domReady = 500.0, nav = "navigate",
                  title = Titles.GetValueOrDefault(page.StartsWith("/boutique/produit") ? "/boutique/produit" : page, "Boutique"), referrer = Pick(r, Referrers), query = Pick(r, Campaigns) },
            new { type = "vital", ts = now, path = page, name = "lcp", value = Math.Round((900 + r.NextDouble() * 2200) * slow) },
            new { type = "vital", ts = now, path = page, name = "fcp", value = Math.Round(300 + r.NextDouble() * 900) },
            new { type = "vital", ts = now, path = page, name = "inp", value = Math.Round(40 + r.NextDouble() * (r.Next(10) == 0 ? 600 : 160)) },
            new { type = "vital", ts = now, path = page, name = "cls", value = Math.Round(r.NextDouble() * (r.Next(6) == 0 ? 0.3 : 0.06), 3) },
        };

        // Appel réel à l'API avec un en-tête traceparent : la trace du serveur prolonge celle du navigateur.
        if (page is "/boutique/panier" or "/boutique/commande" || page.StartsWith("/boutique/produit"))
        {
            var trace = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            var span = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
            var url = page == "/boutique/commande" && r.Next(8) == 0 ? "/api/fail" : $"/api/orders/{r.Next(1, 500)}";
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

        AddAudience(events, r, page, now);

        var batch = new
        {
            service = "boutique-web", env = "démo", session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4)), ua = Agents[r.Next(Agents.Length)],
            lang = Pick(r, Languages), screen = "1920x1080", hostname = host, events,
        };
        using var send = new HttpRequestMessage(HttpMethod.Post, $"v1/rum?k={Uri.EscapeDataString(key)}") { Content = JsonContent.Create(batch) };
        send.Headers.Add("Origin", "https://boutique.exemple.fr");
        // Chaque visite simulée vient d'une adresse différente : visiteurs anonymes distincts.
        send.Headers.Add("X-Forwarded-For", $"198.51.100.{r.Next(1, 250)}");
        using var _ = await wolflog.SendAsync(send, ct);
    }
}
