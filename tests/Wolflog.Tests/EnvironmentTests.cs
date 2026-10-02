using OpenTelemetry.Proto.Collector.Logs.V1;
using Wolflog.Server.Configuration;

namespace Wolflog.Tests;

/// <summary>
/// Environnements configurés : regroupement des valeurs reçues, alias propres à une application, valeurs brutes inchangées,
/// environnements masqués, liste du sélecteur et regroupement automatique (sans serveur : stockage et requêtes directement).
/// </summary>
public class EnvironmentTests
{
    private static readonly DateTime From = DateTime.UtcNow.AddHours(-1);
    private static DateTime To => DateTime.UtcNow.AddMinutes(5);

    /// <summary>
    /// production regroupe prod et prd (et « Production », son nom, sans tenir compte de la casse) ; preproduction regroupe staging.
    /// Pour billing seulement, « prod » est la préproduction.
    /// </summary>
    private static EnvironmentSettings Settings() => new()
    {
        Environments =
        [
            new() { Name = "production", Label = "Production", Kind = EnvironmentKinds.Production, Aliases = ["prod", "prd"] },
            new() { Name = "preproduction", Label = "Préproduction", Kind = EnvironmentKinds.Recette, Color = "#0ea5e9", Order = 1, Aliases = ["staging"] },
        ],
        Apps = [new() { Service = "billing", Aliases = new() { ["prod"] = "preproduction" } }],
    };

    /// <summary>Logs d'une application avec la valeur d'environnement qu'elle envoie (1 sur 10 en erreur).</summary>
    private static ExportLogsServiceRequest Logs(string service, string env, int count, DateTime? at = null)
    {
        var request = Otlp.Logs(service, count, at);
        request.ResourceLogs[0].Resource.Attributes.Single(a => a.Key == "deployment.environment.name").Value.StringValue = env;
        return request;
    }

    /// <summary>
    /// api : prod ×10, Production ×5, PRD ×3 ; billing : prod ×7, production ×4 ; web : staging ×6, demo ×2 ; old : prod-eu ×1.
    /// Production = 22 logs (api 18, billing 4) ; préproduction = 13 (billing 7, web 6).
    /// </summary>
    private static async Task<(TempDir Dir, StorageHost Storage)> Seed()
    {
        var dir = new TempDir();
        var storage = Otlp.CreateStorage(dir.Path);
        foreach (var (service, env, count) in new[]
                 {
                     ("api", "prod", 10), ("api", "Production", 5), ("api", "PRD", 3), ("billing", "prod", 7), ("billing", "production", 4),
                     ("web", "staging", 6), ("web", "demo", 2), ("old", "prod-eu", 1),
                 })
        {
            var request = Logs(service, env, count);
            await storage.Logs.IngestAsync(OtlpConverter.ConvertLogs(request), request.ToByteArray());
        }
        return (dir, storage);
    }

    private static List<(string Service, string? Env)> Rows(QueryService qs, string? env, SearchQuery? q = null)
    {
        qs.Env = env;
        return qs.SearchLogs(From, To, q ?? new SearchQuery(), 5000, null, default).Items.Select(i => (i.Service, i.Env)).ToList();
    }

    private static Dictionary<string, int> Count(IEnumerable<(string Service, string? Env)> rows) =>
        rows.GroupBy(r => $"{r.Service}/{r.Env}").ToDictionary(g => g.Key, g => g.Count());

    [Fact]
    public async Task Configured_environment_groups_values_of_every_application()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var qs = new QueryService(storage) { EnvFilter = new EnvironmentFilter(Settings()) };

        // Nom (toute casse) et alias (toute casse) ; pas le « prod » de billing, qui est sa préproduction.
        var production = Count(Rows(qs, "production"));
        Assert.Equal(new Dictionary<string, int> { ["api/prod"] = 10, ["api/Production"] = 5, ["api/PRD"] = 3, ["billing/production"] = 4 }, production);
        Assert.Equal(production, Count(Rows(qs, "Production")));

        var preproduction = Count(Rows(qs, "preproduction"));
        Assert.Equal(new Dictionary<string, int> { ["billing/prod"] = 7, ["web/staging"] = 6 }, preproduction);

        // Les autres requêtes passent par la même condition : services, histogramme.
        qs.Env = "production";
        var services = qs.Services(From, To, default);
        Assert.Equal(["api", "billing"], services.Select(s => s.Name));
        Assert.Equal(22, services.Sum(s => s.Logs));
        Assert.Equal(22, qs.LogHistogram(From, To, new SearchQuery(), default).Buckets.Sum(b => b.Trace + b.Debug + b.Info + b.Warn + b.Error + b.Fatal));
    }

    [Fact]
    public void Same_value_means_a_different_environment_in_each_application()
    {
        var filter = new EnvironmentFilter(Settings());
        Assert.Equal("production", filter.Resolve("api", "prod"));
        Assert.Equal("production", filter.Resolve("api", "PROD"));
        Assert.Equal("preproduction", filter.Resolve("billing", "prod"));
        Assert.Equal("preproduction", filter.Resolve("billing", "Prod"));
        // Les autres valeurs de billing suivent la règle commune ; une valeur inconnue n'est pas regroupée.
        Assert.Equal("production", filter.Resolve("billing", "prd"));
        Assert.Null(filter.Resolve("api", "prod-eu"));
        Assert.Null(filter.Resolve("api", null));

        // Condition exacte : les alias de billing ne s'appliquent qu'à billing.
        Assert.Equal(
            "((service = 'billing' AND lower(env) IN ('prd', 'production')) OR (service NOT IN ('billing') AND lower(env) IN ('prd', 'prod', 'production')))",
            filter.Condition("production"));
        Assert.Equal(
            "((service = 'billing' AND lower(env) IN ('preproduction', 'prod', 'staging')) OR (service NOT IN ('billing') AND lower(env) IN ('preproduction', 'staging')))",
            filter.Condition("preproduction"));

        // Suivi en direct : même règle, en mémoire.
        var q = new SearchQuery { EnvFilter = filter };
        q.Columns.Add(("env", "preproduction"));
        Assert.True(q.Matches(new LogRow { Service = "billing", Env = "prod" }));
        Assert.True(q.Matches(new LogRow { Service = "web", Env = "Staging" }));
        Assert.False(q.Matches(new LogRow { Service = "api", Env = "prod" }));
        Assert.False(q.Matches(new LogRow { Service = "api", Env = null }));
    }

    [Fact]
    public async Task Raw_values_are_compared_as_before()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var configured = new QueryService(storage) { EnvFilter = new EnvironmentFilter(Settings()) };
        var plain = new QueryService(storage);

        // Valeur qui n'est pas un nom d'environnement (lien d'avant la configuration) : égalité exacte, regroupements ignorés.
        foreach (var qs in new[] { configured, plain })
        {
            Assert.Equal(new Dictionary<string, int> { ["api/prod"] = 10, ["billing/prod"] = 7 }, Count(Rows(qs, "prod")));
            Assert.Empty(Rows(qs, "PROD"));
            Assert.Equal(new Dictionary<string, int> { ["web/demo"] = 2 }, Count(Rows(qs, "demo")));
            Assert.Empty(Rows(qs, "inconnu"));
            Assert.Equal(38, Rows(qs, null).Count);
        }
        Assert.Equal("env = 'prod'", configured.EnvFilter.Condition("prod"));
        Assert.Equal("env = 'l''env'", EnvironmentFilter.None.Condition("l'env"));

        // Sans configuration : « production » est une valeur comme une autre.
        Assert.Equal(new Dictionary<string, int> { ["billing/production"] = 4 }, Count(Rows(plain, "production")));

        // Suivi en direct : valeur exacte, ou motif avec * comme avant.
        var tail = new SearchQuery { EnvFilter = configured.EnvFilter };
        tail.Columns.Add(("env", "prod"));
        Assert.True(tail.Matches(new LogRow { Service = "billing", Env = "prod" }));
        Assert.False(tail.Matches(new LogRow { Service = "api", Env = "prd" }));
        var pattern = new SearchQuery { EnvFilter = configured.EnvFilter };
        pattern.Columns.Add(("env", "prod*"));
        Assert.True(pattern.Matches(new LogRow { Service = "old", Env = "prod-eu" }));
    }

    [Fact]
    public async Task Search_syntax_and_custom_queries_use_configured_environments()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var trace = Otlp.Trace("billing", "4bf92f3577b34da6a3ce929d0e0e4736", DateTime.UtcNow, 3);
        trace.ResourceSpans[0].Resource.Attributes.Single(a => a.Key == "deployment.environment.name").Value.StringValue = "prod";
        await storage.Spans.IngestAsync(OtlpConverter.ConvertSpans(trace), trace.ToByteArray());
        var qs = new QueryService(storage) { EnvFilter = new EnvironmentFilter(Settings()) };

        // env:production dans la barre de recherche.
        var q = SearchQuery.Parse("env:production");
        q.EnvFilter = qs.EnvFilter;
        Assert.Equal(22, Rows(qs, null, q).Count);

        // Requête personnalisée (tableaux de bord, alertes) : logs et spans.
        var logs = qs.Custom(new CustomQuery("logs", "env:preproduction", "count", null, null, "stat", 1, null), From, To, default);
        Assert.Equal(13, logs.Value);
        var spans = qs.Custom(new CustomQuery("spans", "env:preproduction", "count", null, null, "stat", 1, null), From, To, default);
        Assert.Equal(3, spans.Value);
        Assert.Equal(0, qs.Custom(new CustomQuery("spans", "env:production", "count", null, null, "stat", 1, null), From, To, default).Value);
        // Environnement choisi dans la barre du haut.
        qs.Env = "preproduction";
        Assert.Equal(3, qs.Custom(new CustomQuery("spans", null, "count", null, null, "stat", 1, null), From, To, default).Value);
    }

    [Fact]
    public async Task Selector_groups_values_and_counts_activity()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var qs = new QueryService(storage) { EnvFilter = new EnvironmentFilter(Settings()), Env = "demo" };

        var list = qs.EnvironmentStats(null, default);
        Assert.Equal(["production", "preproduction", "demo", "prod-eu"], list.Select(e => e.Name));
        Assert.Equal([0, 1, 2, 3], list.Select(e => e.Order));
        Assert.Equal("demo", qs.Env); // l'environnement choisi ne change pas la liste, et reste choisi

        var production = list[0];
        Assert.True(production.Configured);
        Assert.Equal(("Production", "production", "danger"), (production.Label, production.Kind, production.Tone));
        Assert.Equal((22L, 4L, 2), (production.Logs, production.Errors, production.Services));
        Assert.Equal(["PRD", "Production", "prod", "production"], production.Raw);
        Assert.Equal(["api", "billing"], production.Apps.Select(a => a.Service));
        Assert.Equal(["PRD", "Production", "prod"], production.Apps[0].Raw);
        Assert.Equal(["production"], production.Apps[1].Raw);
        Assert.NotNull(production.LastSeen);

        var preproduction = list[1];
        Assert.Equal(("Préproduction", "warn", "#0ea5e9"), (preproduction.Label, preproduction.Tone, preproduction.Color));
        Assert.Equal(13, preproduction.Logs);
        Assert.Equal(["billing", "web"], preproduction.Apps.Select(a => a.Service));
        Assert.Equal(["prod"], preproduction.Apps[0].Raw);

        // Valeurs non regroupées : telles quelles, couleur devinée d'après le nom.
        Assert.False(list[2].Configured);
        Assert.Equal(("demo", "autre", "accent", 2L), (list[2].Label, list[2].Kind, list[2].Tone, list[2].Logs));
        Assert.Equal(("prod-eu", "danger"), (list[3].Label, list[3].Tone));

        // Une application : ses environnements seulement, avec sa propre activité.
        var billing = qs.EnvironmentStats("billing", default);
        Assert.Equal(["production", "preproduction"], billing.Select(e => e.Name));
        Assert.Equal([4L, 7L], billing.Select(e => e.Logs));
        Assert.All(billing, e => Assert.Equal(1, e.Services));
        Assert.Equal(["production", "preproduction", "demo", "prod-eu"], qs.Environments(null, default));
        Assert.Equal(["preproduction", "demo"], qs.Environments("web", default));
    }

    [Fact]
    public async Task Without_configuration_the_selector_lists_received_values()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var list = new QueryService(storage).EnvironmentStats(null, default);

        // Comme avant : valeurs reçues par ordre alphabétique, variantes de casse réunies, couleur devinée d'après le nom.
        Assert.Equal(["demo", "PRD", "prod", "prod-eu", "Production", "staging"], list.Select(e => e.Name));
        Assert.All(list, e => Assert.False(e.Configured));
        Assert.Equal(17, list.Single(e => e.Name == "prod").Logs);
        Assert.Equal(9, list.Single(e => e.Name == "Production").Logs);
        Assert.Equal(["Production", "production"], list.Single(e => e.Name == "Production").Raw);
        Assert.Equal(["danger", "warn"], list.Where(e => e.Name is "prod" or "staging").Select(e => e.Tone));
    }

    [Fact]
    public async Task Hidden_environments_are_left_out_of_the_selector_only()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var settings = Settings();
        settings.Environments[1].Hidden = true;
        settings.Apps[0].Hidden = ["production"];
        settings.Apps.Add(new AppEnvironments { Service = "web", Hidden = ["demo"] });
        var qs = new QueryService(storage) { EnvFilter = new EnvironmentFilter(settings) };

        // Masqué partout : absent de toutes les listes. Masqué pour une application : absent quand elle est choisie.
        Assert.Equal(["production", "demo", "prod-eu"], qs.Environments(null, default));
        Assert.Empty(qs.Environments("billing", default));
        Assert.Empty(qs.Environments("web", default));
        Assert.Equal(["production"], qs.Environments("api", default));

        // Les données restent accessibles (lien, alerte, recherche).
        Assert.Equal(13, Rows(qs, "preproduction").Count);
        Assert.Equal(2, Rows(qs, "demo").Count);
    }

    [Fact]
    public void Settings_are_cleaned_or_refused_with_a_reason()
    {
        var (clean, error) = EnvironmentStore.Check(new EnvironmentSettings
        {
            Environments =
            [
                new() { Name = " Recette ", Label = " ", Kind = "RECETTE", Color = "#ABC", Order = 5, Aliases = ["uat", " UAT ", "recette", ""] },
                new() { Name = "production", Label = "Production", Order = 1, Aliases = ["prod"] },
            ],
            Apps =
            [
                new() { Service = " billing ", Aliases = new() { ["prod"] = "Recette", ["Demo"] = "" }, Hidden = ["PRODUCTION", "demo", "demo"] },
                new() { Service = "vide" },
            ],
        });
        Assert.Null(error);
        Assert.Equal(["production", "recette"], clean!.Environments.Select(e => e.Name));
        Assert.Equal([0, 1], clean.Environments.Select(e => e.Order));
        var recette = clean.Environments[1];
        Assert.Equal(("recette", EnvironmentKinds.Recette, "#aabbcc"), (recette.Label, recette.Kind, recette.Color));
        Assert.Equal(["uat"], recette.Aliases);
        Assert.Equal(EnvironmentKinds.Other, clean.Environments[0].Kind);
        var billing = Assert.Single(clean.Apps);
        Assert.Equal("billing", billing.Service);
        Assert.Equal(new Dictionary<string, string> { ["prod"] = "recette", ["Demo"] = "" }, billing.Aliases);
        Assert.Equal(["production", "demo"], billing.Hidden);

        string Refusal(EnvironmentSettings s) => EnvironmentStore.Check(s).Error ?? "(accepté)";
        Assert.Contains("invalide", Refusal(new() { Environments = [new() { Name = "pré-prod" }] }));
        Assert.Contains("nom", Refusal(new() { Environments = [new() { Name = "  " }] }));
        Assert.Contains("Deux environnements", Refusal(new() { Environments = [new() { Name = "prod" }, new() { Name = "PROD" }] }));
        Assert.Contains("à la fois", Refusal(new() { Environments = [new() { Name = "production", Aliases = ["prod"] }, new() { Name = "recette", Aliases = ["Prod"] }] }));
        Assert.Contains("à la fois", Refusal(new() { Environments = [new() { Name = "prod" }, new() { Name = "production", Aliases = ["prod"] }] }));
        Assert.Contains("Type", Refusal(new() { Environments = [new() { Name = "x", Kind = "rouge" }] }));
        Assert.Contains("#RRGGBB", Refusal(new() { Environments = [new() { Name = "x", Color = "bleu" }] }));
        Assert.Contains("inconnu", Refusal(new() { Environments = [new() { Name = "x" }], Apps = [new() { Service = "a", Aliases = new() { ["prod"] = "y" } }] }));
        Assert.Contains("nom de l'environnement", Refusal(new() { Environments = [new() { Name = "x" }], Apps = [new() { Service = "a", Aliases = new() { ["X"] = "" } }] }));
        Assert.Contains("même valeur", Refusal(new() { Environments = [new() { Name = "x" }], Apps = [new() { Service = "a", Aliases = new() { ["prod"] = "x", ["PROD"] = "" } }] }));
        Assert.Contains("deux réglages", Refusal(new() { Apps = [new() { Service = "a", Hidden = ["x"] }, new() { Service = "a", Hidden = ["y"] }] }));
    }

    [Fact]
    public void Automatic_grouping_proposes_usual_environments()
    {
        var received = new[] { "prod", "Production", "PRD", "staging", "Pré-prod", "uat", "Recette", "dev", "local", "QA", "prod-eu", "demo" };
        var (proposal, grouped, created) = EnvironmentSuggestion.Propose(new EnvironmentSettings(), received);

        Assert.Equal(["production", "preproduction", "recette", "test", "developpement"], proposal.Environments.Select(e => e.Name));
        Assert.Equal(["Production", "Préproduction", "Recette", "Test", "Développement"], proposal.Environments.Select(e => e.Label));
        Assert.Equal([0, 1, 2, 3, 4], proposal.Environments.Select(e => e.Order));
        Assert.Equal(["PRD", "prod"], proposal.Environments[0].Aliases); // « Production » est son nom
        Assert.Equal(["Pré-prod", "staging"], proposal.Environments[1].Aliases);
        Assert.Equal(["uat"], proposal.Environments[2].Aliases);
        Assert.Equal(["QA"], proposal.Environments[3].Aliases);
        Assert.Equal(["dev", "local"], proposal.Environments[4].Aliases);
        Assert.Equal(EnvironmentKinds.Developpement, proposal.Environments[4].Kind);
        Assert.Equal((10, 5), (grouped, created));
        Assert.Null(EnvironmentStore.Check(proposal).Error);

        // Réglages en cours de saisie : gardés, complétés ; une valeur déjà regroupée ne bouge pas.
        var draft = new EnvironmentSettings
        {
            Environments = [new() { Name = "prd", Label = "Prod", Kind = EnvironmentKinds.Production, Order = 3, Aliases = ["production", "staging"] }],
        };
        var (completed, more, added) = EnvironmentSuggestion.Propose(draft, ["prod", "staging", "dev"]);
        Assert.Equal(["prd", "developpement"], completed.Environments.Select(e => e.Name));
        Assert.Equal(["production", "staging", "prod"], completed.Environments[0].Aliases);
        Assert.Equal(4, completed.Environments[1].Order);
        Assert.Equal((2, 1), (more, added));
        Assert.Equal(["production", "staging"], draft.Environments[0].Aliases); // la saisie n'est pas modifiée
    }
}
