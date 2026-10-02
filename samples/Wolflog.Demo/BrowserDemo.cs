/// <summary>
/// Petite boutique instrumentée par wolflog-rum.js (/boutique) : vraies pages, liens et boutons, pour tester
/// l'audience, les cartes de chaleur (aperçu de la page réelle) et le suivi navigateur (erreurs, appels reliés aux traces).
/// Les visiteurs simulés (<see cref="BrowserSimulator"/>) parcourent ces mêmes pages.
/// </summary>
internal static class BrowserDemo
{
    private static readonly (string Name, string Price, string Color)[] Products =
    [
        ("Lampe Oslo", "89 €", "#e8d5b7"), ("Fauteuil Nara", "349 €", "#c9d6c3"), ("Vase Bora", "39 €", "#d7c4d9"), ("Tapis Sahel", "159 €", "#e3cdb8"),
        ("Miroir Lina", "119 €", "#c7d3de"), ("Chaise Tove", "129 €", "#dccdb4"), ("Plaid Isla", "59 €", "#d9c8c0"), ("Étagère Ren", "199 €", "#cbd5cf"),
    ];

    public static void MapBrowserDemo(this WebApplication app)
    {
        app.MapGet("/boutique", (IConfiguration config) => Page(config, "Accueil", Home()));
        app.MapGet("/boutique/catalogue", (IConfiguration config) => Page(config, "Catalogue", Catalogue()));
        app.MapGet("/boutique/produit/{id:int}", (IConfiguration config, int id) => Page(config, "Fiche produit", Product(id)));
        app.MapGet("/boutique/panier", (IConfiguration config) => Page(config, "Panier", Cart()));
        app.MapGet("/boutique/commande", (IConfiguration config) => Page(config, "Commande", Checkout()));
        app.MapGet("/boutique/atelier", (IConfiguration config) => Page(config, "Atelier", Workshop()));
    }

    private static IResult Page(IConfiguration config, string title, string body)
    {
        var endpoint = (config["Wolflog:Endpoint"] ?? "http://localhost:5080").TrimEnd('/');
        var key = config["Wolflog:BrowserKey"] is { Length: > 0 } k ? k : config["Wolflog:ApiKey"] ?? "";
        var html = $$"""
            <!doctype html>
            <html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
            <title>{{title}}  Boutique</title>
            <script src="{{endpoint}}/wolflog-rum.js" defer data-key="{{key}}" data-service="boutique-web" data-env="démo"></script>
            <style>
              *{box-sizing:border-box} body{margin:0;font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1d1d1b;background:#faf9f7}
              a{color:inherit;text-decoration:none} .wrap{max-width:1120px;margin:0 auto;padding:0 24px}
              header{height:72px;display:flex;align-items:center;border-bottom:1px solid #ebe8e3;background:#fff}
              .barre{display:flex;align-items:center;gap:28px;width:100%}
              .logo{font-weight:700;font-size:19px;letter-spacing:-.02em;margin-right:auto} nav{display:flex;gap:24px;color:#57544f}
              .panier{padding:8px 16px;border-radius:20px;background:#1d1d1b;color:#fff;font-weight:600}
              .hero{padding:72px 0 64px} .hero h1{font-size:48px;line-height:1.05;letter-spacing:-.03em;margin:0 0 16px;max-width:620px}
              .hero p{font-size:18px;color:#57544f;max-width:520px;margin:0 0 28px}
              .cta,.ajouter,.payer{display:inline-block;border:0;border-radius:24px;background:#1d1d1b;color:#fff;font:600 15px system-ui;padding:14px 26px;cursor:pointer}
              .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;padding-bottom:56px}
              .carte{background:#fff;border:1px solid #ebe8e3;border-radius:16px;padding:14px}
              .carte .img{height:180px;border-radius:10px} .carte h3{margin:12px 0 2px;font-size:16px} .carte .prix{color:#57544f;margin-bottom:12px}
              .carte .ajouter{padding:9px 16px;font-size:13px}
              .bandeau{background:#fff;border:1px solid #ebe8e3;border-radius:16px;padding:40px;margin-bottom:56px;display:flex;gap:40px}
              .bandeau div{flex:1} .bandeau h2{margin:0 0 8px;font-size:20px} .bandeau p{margin:0;color:#57544f}
              h1.titre{font-size:32px;letter-spacing:-.02em;margin:40px 0 24px} h2.section{font-size:24px;letter-spacing:-.02em;margin:0 0 20px}
              .fiche{display:grid;grid-template-columns:1fr 1fr;gap:48px;padding:40px 0 64px} .fiche .img{height:440px;border-radius:16px}
              .fiche h1{font-size:36px;margin:0 0 8px} .fiche .prix{font-size:22px;margin-bottom:20px} .fiche p{color:#57544f;margin:0 0 28px}
              .ligne{display:flex;align-items:center;gap:16px;background:#fff;border:1px solid #ebe8e3;border-radius:14px;padding:14px;margin-bottom:12px}
              .ligne .img{width:72px;height:72px;border-radius:10px} .ligne b{flex:1}
              .total{display:flex;justify-content:space-between;align-items:center;margin:24px 0 64px;font-size:18px}
              form{display:grid;gap:14px;max-width:520px;margin-bottom:28px} label{display:grid;gap:6px;color:#57544f;font-size:14px}
              input{height:44px;border:1px solid #d9d5ce;border-radius:10px;padding:0 12px;font:15px system-ui;background:#fff}
              footer{border-top:1px solid #ebe8e3;padding:32px 24px 48px;color:#8a867f;display:flex;gap:24px}
              #out{background:#fff;border:1px solid #ebe8e3;border-radius:10px;padding:12px;white-space:pre-wrap}
              .atelier button{margin:4px 8px 4px 0;padding:8px 14px;border-radius:8px;border:1px solid #d9d5ce;background:#fff;cursor:pointer}
              @media (max-width:760px){.grid{grid-template-columns:1fr 1fr}.hero h1{font-size:34px}.fiche{grid-template-columns:1fr}.bandeau{flex-direction:column}
                .barre{gap:14px} nav{gap:12px;font-size:14px} }
            </style>
            </head><body>
            <header><div class="wrap barre">
              <a class="logo" href="/boutique">Maison Nord</a>
              <nav><a href="/boutique/catalogue">Catalogue</a><a href="/boutique/catalogue?promo=1">Promotions</a></nav>
              <a class="panier" href="/boutique/panier">Panier</a>
            </div></header>
            <main class="wrap">{{body}}</main>
            <footer class="wrap"><a href="/boutique">Maison Nord</a><a href="/boutique/catalogue">Catalogue</a><a href="/boutique/atelier">Atelier Wolflog</a></footer>
            <script>
              function ajouter(id){ fetch('/api/orders/' + id); window.wolflog && wolflog.track('ajout-panier', { produit: id }); }
              function payer(){ window.wolflog && wolflog.track('commande', { revenue: 348, currency: 'EUR' }); document.querySelector('.payer').textContent = 'Merci !'; }
            </script>
            </body></html>
            """;
        return Results.Content(html, "text/html; charset=utf-8");
    }

    private static string Card(int i)
    {
        var (name, price, color) = Products[i % Products.Length];
        return $"""<article class="carte"><a href="/boutique/produit/{i + 1}"><div class="img" style="background:{color}"></div><h3>{name}</h3></a><div class="prix">{price}</div><button class="ajouter" onclick="ajouter({i + 1})">Ajouter au panier</button></article>""";
    }

    private static string Home() => $"""
        <section class="hero">
          <h1>Des objets simples pour une maison calme</h1>
          <p>Mobilier et décoration dessinés en Europe, livrés en 48 h.</p>
          <a class="cta" href="/boutique/catalogue">Voir les nouveautés</a>
        </section>
        <div class="grid">{string.Concat(Enumerable.Range(0, 4).Select(Card))}</div>
        <section class="bandeau">
          <div><h2>Livraison offerte</h2><p>Dès 80 € d'achat, partout en France.</p></div>
          <div><h2>Retours 30 jours</h2><p>Changez d'avis, on s'occupe du reste.</p></div>
          <div><h2>Paiement sécurisé</h2><p>Carte, virement ou paiement en 3 fois.</p></div>
        </section>
        <h2 class="section">Meilleures ventes</h2>
        <div class="grid">{string.Concat(Enumerable.Range(4, 4).Select(Card))}</div>
        """;

    private static string Catalogue() => $"""<h1 class="titre">Catalogue</h1><div class="grid">{string.Concat(Enumerable.Range(0, 8).Select(Card))}</div>""";

    private static string Product(int id)
    {
        var (name, price, color) = Products[(Math.Max(1, id) - 1) % Products.Length];
        return $"""
            <div class="fiche">
              <div class="img" style="background:{color}"></div>
              <div><h1>{name}</h1><div class="prix">{price}</div>
                <p>Fabriqué à la main en petite série, avec des matériaux durables. Chaque pièce est unique.</p>
                <button class="ajouter" onclick="ajouter({id})">Ajouter au panier</button></div>
            </div>
            """;
    }

    private static string Cart() => $"""
        <h1 class="titre">Panier</h1>
        {string.Concat(new[] { 0, 2 }.Select(i => $"""<div class="ligne"><div class="img" style="background:{Products[i].Color}"></div><b>{Products[i].Name}</b><span>{Products[i].Price}</span></div>"""))}
        <div class="total"><span>Total : 128 €</span><a class="cta" href="/boutique/commande">Commander</a></div>
        """;

    private static string Checkout() => """
        <h1 class="titre">Commande</h1>
        <form onsubmit="return false"><label>Adresse e-mail<input type="email"></label><label>Adresse de livraison<input></label><label>Carte bancaire<input></label></form>
        <button class="payer" onclick="payer()">Payer 348 €</button>
        <div style="height:80px"></div>
        """;

    private static string Workshop() => """
        <h1 class="titre">Atelier Wolflog</h1>
        <p>Chaque action apparaît dans Wolflog : tableau « Expérience navigateur », Erreurs, Requêtes HTTP sortantes de boutique-web, Carte des services.</p>
        <div class="atelier">
          <button onclick="load(42)">Charger la commande 42</button>
          <button onclick="load(Math.floor(Math.random()*500))">Commande au hasard</button>
          <button onclick="fetch('/api/fail').then(r=>show('Statut '+r.status))">Appel en erreur (500)</button>
          <button onclick="panier.total()">Erreur JavaScript</button>
          <button onclick="history.pushState({}, '', '/boutique/atelier/route'); show('Route : /boutique/atelier/route')">Changer de route</button>
        </div>
        <pre id="out">…</pre>
        <script>
          const panier = {};
          function show(t){ document.getElementById('out').textContent = t; }
          function load(id){ fetch('/api/orders/' + id).then(r => r.json()).then(j => show(JSON.stringify(j, null, 2))); }
        </script>
        <div style="height:60px"></div>
        """;
}
