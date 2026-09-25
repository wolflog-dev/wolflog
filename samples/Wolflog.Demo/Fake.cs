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
