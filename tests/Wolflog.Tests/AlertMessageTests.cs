using System.Net.Http.Headers;
using Wolflog.Server.Monitoring;

namespace Wolflog.Tests;

/// <summary>Modèles de message des alertes : rendu par canal, variables, aperçu et envoi de test.</summary>
public class AlertMessageTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static readonly Dictionary<string, string?> Vars = new(StringComparer.OrdinalIgnoreCase)
    {
        ["service"] = "api-commandes", ["valeur"] = "7,2 %", ["seuil"] = "5 %", ["consigne"] = null,
        ["lien"] = "https://wolflog.exemple.fr/requests", ["erreur"] = "<script>alert(1)</script>",
    };

    private static async Task<JsonElement> Post(HttpClient client, string url, object body)
    {
        var response = await client.PostAsJsonAsync(url, body);
        if (!response.IsSuccessStatusCode) Assert.Fail($"{url} : {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var text = await response.Content.ReadAsStringAsync();
        return string.IsNullOrEmpty(text) ? default : JsonSerializer.Deserialize<JsonElement>(text, Json);
    }

    [Fact]
    public void Template_renders_formatting_variables_and_lists_per_channel()
    {
        var t = MessageTemplate.Parse("**{{service}}** : _{{valeur}}_ > {{seuil}}\n- Consigne : {{consigne}}\n- [Voir]({{lien}})\n\nErreur : {{erreur}}");

        var html = t.Html(Vars);
        Assert.Contains("<strong>api-commandes</strong> : <em>7,2 %</em> &gt; 5 %", html);
        Assert.DoesNotContain("Consigne", html); // ligne dont toutes les variables sont vides : retirée
        Assert.Contains("<li><a href=\"https://wolflog.exemple.fr/requests\">Voir</a></li>", html);
        Assert.Contains("&lt;script&gt;", html); // valeurs échappées
        Assert.DoesNotContain("<script>", html);

        Assert.Equal("*api-commandes* : _7,2 %_ &gt; 5 %\n• <https://wolflog.exemple.fr/requests|Voir>\n\nErreur : &lt;script&gt;alert(1)&lt;/script&gt;", t.Slack(Vars));
        Assert.Equal("api-commandes : 7,2 % > 5 %\n• Voir (https://wolflog.exemple.fr/requests)\n\nErreur : <script>alert(1)</script>", t.Plain(Vars));
    }

    [Fact]
    public void Template_keeps_literal_characters_and_rejects_unsafe_links()
    {
        var t = MessageTemplate.Parse(@"nom\_de\_table snake_case {{service}} [clic](javascript:alert(1)) 2 * 3");
        Assert.Equal("nom_de_table snake_case api-commandes clic 2 * 3", t.Plain(Vars));
        Assert.Equal("", MessageTemplate.Parse("Consigne : {{consigne}}").Plain(Vars));
    }

    [Fact]
    public void Teams_mentions_become_entities()
    {
        var (blocks, mentions) = MessageTemplate.Parse("@[Astreinte](astreinte@exemple.fr) regardez {{service}}").Teams(Vars);
        var json = JsonSerializer.Serialize(new { blocks, mentions }, new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        Assert.Contains("<at>Astreinte</at> regardez api-commandes", json);
        Assert.Contains("\"mentioned\":{\"id\":\"astreinte@exemple.fr\",\"name\":\"Astreinte\"}", json);
        Assert.Equal("<@U0123ABC> ok", MessageTemplate.Parse("@[Marie](U0123ABC) ok").Slack(Vars));
    }

    [Fact]
    public async Task Preview_uses_rule_data_and_custom_template_is_sent()
    {
        var ui = await server.LoggedInClient();
        var service = "svc-msg-" + Guid.NewGuid().ToString("N")[..6];
        var client = server.CreateClient();
        for (var i = 0; i < 10; i++)
        {
            var trace = Otlp.Trace(service, Guid.NewGuid().ToString("N"), DateTime.UtcNow.AddSeconds(-20), 1, error: i % 2 == 0);
            using var content = new ByteArrayContent(trace.ToByteArray());
            content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
            using var message = new HttpRequestMessage(HttpMethod.Post, "/v1/traces") { Content = content };
            message.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
            (await client.SendAsync(message)).EnsureSuccessStatusCode();
        }

        var channel = await Post(ui, "/api/alert-channels", new { name = "Slack prod", type = "slack", target = "https://hooks.slack.exemple/msg" });
        var rule = new
        {
            name = "Erreurs " + service, kind = "http", stat = "errorRate", service, threshold = 10, windowMinutes = 5,
            channels = new[] { channel.GetProperty("id").GetString() },
            titleTemplate = "{{statut}} sur {{service}}",
            bodyTemplate = "**{{valeur}}** d'erreurs ({{erreurs}} sur {{requetes}} requêtes), seuil {{seuil}}\n@[Équipe](here)",
        };

        // Aperçu : évaluation réelle de la règle.
        var preview = await Post(ui, "/api/alerts/message/preview", new { rule });
        Assert.False(preview.GetProperty("sample").GetBoolean());
        Assert.Equal($"Alerte sur {service}", preview.GetProperty("preview").GetProperty("title").GetString());
        Assert.Equal("*50 %* d'erreurs (5 sur 10 requêtes), seuil 10 %\n<!here>", preview.GetProperty("preview").GetProperty("slack").GetString());
        Assert.Contains(preview.GetProperty("variables").EnumerateArray(), v => v.GetProperty("name").GetString() == "derniere_erreur");

        // Sans règle (modèle par défaut) : valeurs d'exemple.
        var sample = await Post(ui, "/api/alerts/message/preview", new { rule = (object?)null });
        Assert.True(sample.GetProperty("sample").GetBoolean());
        Assert.Equal("Alerte : Taux d'erreur de api-commandes", sample.GetProperty("preview").GetProperty("title").GetString());

        // Aperçu de la résolution : statut « Résolu » et durée d'exemple.
        var resolved = await Post(ui, "/api/alerts/message/preview", new { rule = rule with { }, title = "{{statut}} après {{duree}}", status = "resolved" });
        Assert.Equal("Résolu après 12 min", resolved.GetProperty("preview").GetProperty("title").GetString());

        // Envoi de test, puis envoi réel par le moteur d'alertes avec le modèle de la règle.
        await Post(ui, "/api/alerts/message/test", new { rule });
        Assert.Contains(server.Notifications.Requests, r => r.Url.Host == "hooks.slack.exemple" && r.Body.Contains($"Test sur {service}"));
        await Post(ui, "/api/alerts", rule);
        await Post(ui, "/api/alerts/run", new { });
        Assert.Contains(server.Notifications.Requests, r => r.Url.Host == "hooks.slack.exemple" && r.Body.Contains($"*Alerte sur {service}*"));
    }

    [Fact]
    public async Task Default_template_applies_to_rules_without_their_own()
    {
        var ui = await server.LoggedInClient();
        (await ui.PutAsJsonAsync("/api/notification-settings/templates", new { title = "[{{severite}}] {{regle}}", body = "{{message}}" })).EnsureSuccessStatusCode();
        try
        {
            var preview = await Post(ui, "/api/alerts/message/preview", new { rule = (object?)null });
            Assert.Equal("[critique] Taux d'erreur de api-commandes", preview.GetProperty("preview").GetProperty("title").GetString());
            Assert.Equal("{{message}}", preview.GetProperty("bodyTemplate").GetString());

            // Les paramètres SMTP enregistrés ensuite ne touchent pas au modèle.
            (await ui.PutAsJsonAsync("/api/notification-settings", new { smtpPort = 587, smtpSsl = true })).EnsureSuccessStatusCode();
            var settings = await ui.GetFromJsonAsync<JsonElement>("/api/notification-settings", Json);
            Assert.Equal("[{{severite}}] {{regle}}", settings.GetProperty("titleTemplate").GetString());
        }
        finally
        {
            (await ui.PutAsJsonAsync("/api/notification-settings/templates", new { title = (string?)null, body = (string?)null })).EnsureSuccessStatusCode();
        }
    }
}
