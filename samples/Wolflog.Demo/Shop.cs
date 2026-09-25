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
