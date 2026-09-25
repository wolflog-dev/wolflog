using System.Globalization;

/// <summary>
/// Endpoints volontairement "lourds" pour voir le rendu dans Wolflog : nombreux paramètres d'URL,
/// corps JSON imbriqués, grosses réponses, erreurs de validation détaillées.
/// </summary>
internal static class Shop
{
    public static void MapShop(this WebApplication app)
    {
        // Recherche paginée : paramètres d'URL multiples + filtres complexes dans le corps.
        app.MapPost("/api/orders/search", (OrderSearch search, int page, int pageSize, string? sort, [Microsoft.AspNetCore.Mvc.FromQuery] string[]? status, string? include, string? currency, ILogger<Program> log) =>
        {
            pageSize = Math.Clamp(pageSize, 1, 100);
            var rnd = new Random(page * 31 + pageSize);
            var items = Enumerable.Range(0, pageSize).Select(i => Fake.Order(rnd, (page - 1) * pageSize + i + 1, include)).ToList();
            log.LogInformation("Recherche de commandes page {Page} ({PageSize} par page), {Filters} filtre(s)", page, pageSize, search.CountFilters());
            return Results.Ok(new
            {
                page, pageSize, total = 1_284, sort = sort ?? "-createdAt", status = status ?? [], currency = currency ?? "EUR",
                appliedFilters = search,
                items,
                links = new { next = $"/api/orders/search?page={page + 1}&pageSize={pageSize}", previous = page > 1 ? $"/api/orders/search?page={page - 1}&pageSize={pageSize}" : null },
            });
        });

        // Mise à jour d'un client : gros objet imbriqué, mot de passe (masqué par Wolflog), validation détaillée.
        app.MapPut("/api/customers/{id:int}", (int id, CustomerUpdate update, ILogger<Program> log) =>
        {
            var errors = new Dictionary<string, string[]>();
            if (!update.Email.Contains('@')) errors["email"] = ["L'adresse e-mail n'est pas valide."];
            if (update.Addresses.Count == 0) errors["addresses"] = ["Au moins une adresse est requise."];
            foreach (var (a, i) in update.Addresses.Select((a, i) => (a, i)))
                if (a.PostalCode.Length != 5) errors[$"addresses[{i}].postalCode"] = [$"Code postal « {a.PostalCode} » invalide (5 chiffres attendus)."];
            if (errors.Count > 0)
            {
                log.LogWarning("Mise à jour du client {CustomerId} refusée : {ErrorCount} erreur(s) de validation", id, errors.Count);
                return Results.ValidationProblem(errors, title: "Données client invalides", statusCode: 422);
            }
            return Results.Ok(new { id, update.FirstName, update.LastName, update.Email, update.Addresses, update.Preferences, updatedAt = DateTime.UtcNow, version = 7 });
        });

        // Rapport volumineux (> 100 Ko) : montre la troncature des corps trop gros.
        app.MapGet("/api/reports/sales", (DateOnly from, DateOnly to, string groupBy, string? include, string? currency) =>
        {
            var rnd = new Random(from.DayNumber);
            string[] regions = ["Île-de-France", "Auvergne-Rhône-Alpes", "Occitanie", "Nouvelle-Aquitaine", "Hauts-de-France", "Grand Est", "Bretagne", "Normandie"];
            var days = Math.Clamp(to.DayNumber - from.DayNumber + 1, 1, 366);
            var rows = Enumerable.Range(0, days).SelectMany(d => regions.Select(r => new
            {
                date = from.AddDays(d), region = r, orders = rnd.Next(20, 400), revenue = Math.Round(rnd.NextDouble() * 50_000, 2),
                averageBasket = Math.Round(40 + rnd.NextDouble() * 80, 2), returns = rnd.Next(0, 15),
                topProducts = Enumerable.Range(0, 3).Select(k => new { sku = $"SKU-{rnd.Next(1000, 9999)}", units = rnd.Next(1, 60) }),
            })).ToList();
            return Results.Ok(new { from, to, groupBy, currency = currency ?? "EUR", include = include?.Split(','), generatedAt = DateTime.UtcNow, rows });
        });
    }
}

internal sealed record Range<T>(T? Min, T? Max);
internal sealed record DateRange(DateTime? From, DateTime? To);
internal sealed record CustomerFilter(string? NameContains, string[]? Emails, string? Segment, bool? HasLoyaltyCard);
internal sealed record SearchOptions(bool IncludeCancelled, bool IncludeArchived, string Locale, string[] Fields);

internal sealed record OrderSearch(CustomerFilter? Customer, DateRange? CreatedAt, Range<decimal>? Amount, string[]? Tags, string[]? Channels, SearchOptions? Options)
{
    public int CountFilters() => new object?[] { Customer, CreatedAt, Amount, Tags, Channels }.Count(x => x != null);
}

internal sealed record Address(string Label, string Street, string PostalCode, string City, string Country, bool IsDefault);
internal sealed record Preferences(string Language, bool Newsletter, string[] Channels, Dictionary<string, bool> Notifications);
internal sealed record CustomerUpdate(string FirstName, string LastName, string Email, string Phone, string Password, List<Address> Addresses, Preferences Preferences);

internal static class Fake
{
    private static readonly string[] FirstNames = ["Camille", "Louis", "Emma", "Hugo", "Léa", "Jules", "Chloé", "Gabriel", "Manon", "Arthur"];
    private static readonly string[] LastNames = ["Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit", "Durand", "Leroy", "Moreau"];
    private static readonly string[] Cities = ["Paris", "Lyon", "Marseille", "Toulouse", "Nantes", "Lille", "Bordeaux", "Rennes"];
    private static readonly string[] Products = ["Canapé 3 places", "Lampe de bureau", "Table basse chêne", "Tapis berbère", "Miroir rond", "Étagère murale", "Fauteuil velours", "Coussin lin"];
    private static readonly string[] Statuses = ["pending", "paid", "shipped", "delivered", "cancelled"];

    public static object Order(Random rnd, int n, string? include)
    {
        var first = FirstNames[rnd.Next(FirstNames.Length)];
        var last = LastNames[rnd.Next(LastNames.Length)];
        var city = Cities[rnd.Next(Cities.Length)];
        var items = Enumerable.Range(0, rnd.Next(1, 5)).Select(i =>
        {
            var qty = rnd.Next(1, 4);
            var price = Math.Round(15 + rnd.NextDouble() * 400, 2);
            return new
            {
                sku = $"SKU-{rnd.Next(1000, 9999)}", name = Products[rnd.Next(Products.Length)], quantity = qty, unitPrice = price,
                discounts = rnd.Next(3) == 0 ? new[] { new { code = "AUTOMNE10", amount = Math.Round(price * 0.1, 2) } } : [],
                attributes = new Dictionary<string, string> { ["couleur"] = rnd.Next(2) == 0 ? "sable" : "anthracite", ["matière"] = "chêne massif" },
            };
        }).ToList();
        var subtotal = Math.Round(items.Sum(i => i.unitPrice * i.quantity), 2);
        var withHistory = include?.Contains("history", StringComparison.OrdinalIgnoreCase) == true;
        return new
        {
            id = 100_000 + n,
            number = $"CMD-2026-{100_000 + n}",
            createdAt = DateTime.UtcNow.AddMinutes(-rnd.Next(1, 60 * 24 * 30)),
            status = Statuses[rnd.Next(Statuses.Length)],
            customer = new
            {
                id = rnd.Next(1, 50_000), firstName = first, lastName = last,
                email = $"{first.ToLowerInvariant()}.{last.ToLowerInvariant()}@exemple.fr", phone = $"+33 6 {rnd.Next(10, 99)} {rnd.Next(10, 99)} {rnd.Next(10, 99)} {rnd.Next(10, 99)}",
                loyalty = new { tier = rnd.Next(3) switch { 0 => "bronze", 1 => "argent", _ => "or" }, points = rnd.Next(0, 5000) },
            },
            shippingAddress = new { street = $"{rnd.Next(1, 120)} rue de la République", postalCode = rnd.Next(10000, 95999).ToString(CultureInfo.InvariantCulture), city, country = "FR" },
            items,
            totals = new { subtotal, shipping = 9.90, tax = Math.Round(subtotal * 0.2, 2), total = Math.Round(subtotal * 1.2 + 9.90, 2), currency = "EUR" },
            shipment = new { carrier = rnd.Next(2) == 0 ? "Colissimo" : "Chronopost", tracking = $"6A{rnd.NextInt64(10_000_000_000, 99_999_999_999)}" },
            history = withHistory
                ? Enumerable.Range(0, 4).Select(h => new { at = DateTime.UtcNow.AddHours(-h * 12), @event = Statuses[Math.Min(h, 3)], by = "système" }).ToArray()
                : null,
        };
    }

    public static OrderSearch Search(Random rnd) => new(
        new CustomerFilter(FirstNames[rnd.Next(FirstNames.Length)], ["alice@exemple.fr", "bob@exemple.fr"], rnd.Next(2) == 0 ? "premium" : null, true),
        new DateRange(DateTime.UtcNow.AddDays(-30), DateTime.UtcNow),
        new Range<decimal>(50, 2_000),
        ["meuble", "promo-automne"],
        ["web", "mobile", "magasin"],
        new SearchOptions(false, false, "fr-FR", ["id", "number", "customer", "items", "totals", "shipment"]));

    public static CustomerUpdate Customer(Random rnd, bool valid)
    {
        var first = FirstNames[rnd.Next(FirstNames.Length)];
        var last = LastNames[rnd.Next(LastNames.Length)];
        return new CustomerUpdate(
            first, last,
            valid ? $"{first.ToLowerInvariant()}@exemple.fr" : "adresse-invalide",
            "+33 6 12 34 56 78",
            "MotDePasse!2026",
            [
                new Address("Domicile", "12 avenue des Tilleuls", valid ? "69003" : "690", "Lyon", "FR", true),
                new Address("Bureau", "4 place Bellecour", "69002", "Lyon", "FR", false),
            ],
            new Preferences("fr-FR", rnd.Next(2) == 0, ["email", "sms"], new() { ["expédition"] = true, ["promotions"] = false, ["avis"] = true }));
    }
}
