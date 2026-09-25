/// <summary>
/// Page de démonstration du suivi navigateur (/boutique) et visiteurs simulés : ils envoient ce que
/// wolflog-rum.js enverrait (pages, Web Vitals, erreurs JavaScript) et appellent vraiment l'API avec un en-tête
/// traceparent, pour relier le navigateur aux traces du serveur.
/// </summary>
internal static class BrowserDemo
{
    public static void MapBrowserDemo(this WebApplication app)
    {
        app.MapGet("/boutique", (IConfiguration config) =>
        {
            var endpoint = (config["Wolflog:Endpoint"] ?? "http://localhost:5080").TrimEnd('/');
            var key = config["Wolflog:BrowserKey"] is { Length: > 0 } k ? k : config["Wolflog:ApiKey"] ?? "";
            var html = $$"""
                <!doctype html>
                <html lang="fr"><head><meta charset="utf-8"><title>Boutique (démo Wolflog)</title>
                <script src="{{endpoint}}/wolflog-rum.js" defer data-key="{{key}}" data-service="boutique-web" data-env="démo"></script>
                <style>body{font:15px system-ui;margin:40px;max-width:640px}button{margin:4px 8px 4px 0;padding:6px 12px}pre{background:#f4f4f4;padding:10px}</style>
                </head><body>
                <h1>Boutique</h1>
                <p>Page instrumentée par <code>wolflog-rum.js</code> : chaque action ci-dessous apparaît dans Wolflog
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
