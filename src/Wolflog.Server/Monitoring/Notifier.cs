using System.Net;
using System.Net.Mail;

namespace Wolflog.Server.Monitoring;

/// <summary>Envoi des notifications : e-mail (SMTP), Microsoft Teams, Slack, webhook générique.</summary>
public sealed class Notifier(IHttpClientFactory http, AlertChannelStore channels, NotificationSettingsStore settings, ILogger<Notifier> log)
{
    /// <summary>Envoie à chaque canal ; retourne les noms des canaux atteints.</summary>
    public async Task<List<string>> SendAsync(IEnumerable<string> channelIds, AlertNotification n, CancellationToken ct)
    {
        var sent = new List<string>();
        foreach (var id in channelIds.Distinct())
        {
            var channel = channels.Get(id);
            if (channel is null) continue;
            var error = await TrySendAsync(channel, n, ct);
            channels.Update(id, c =>
            {
                if (error is null) c.LastSentAt = DateTime.UtcNow;
                else
                {
                    c.LastErrorAt = DateTime.UtcNow;
                    c.LastError = error;
                }
            });
            if (error is null) sent.Add(channel.Name);
        }
        return sent;
    }

    /// <summary>null si l'envoi a réussi, sinon le message d'erreur.</summary>
    public async Task<string?> TrySendAsync(AlertChannel channel, AlertNotification n, CancellationToken ct)
    {
        try
        {
            switch (channel.Type)
            {
                case "email": await SendEmailAsync(channel, Compose(n), ct); break;
                case "teams": await PostAsync(channel.Target, Teams(Compose(n)), ct); break;
                case "slack": await PostAsync(channel.Target, Slack(Compose(n)), ct); break;
                default: await PostAsync(channel.Target, Webhook(n, Compose(n)), ct); break;
            }
            return null;
        }
        catch (Exception ex) when (ex is HttpRequestException or SmtpException or InvalidOperationException or FormatException or TaskCanceledException or ArgumentException)
        {
            log.LogWarning("Notification {Channel} impossible : {Error}", channel.Name, ex.Message);
            return ex.Message;
        }
    }

    /// <summary>Adresse sous laquelle l'interface a été ouverte (à défaut d'adresse publique configurée).</summary>
    public static string? ObservedOrigin { get; set; }

    public string? AbsoluteLink(string? relative)
    {
        if (string.IsNullOrEmpty(relative)) return null;
        var baseUrl = settings.Current.PublicUrl?.TrimEnd('/');
        if (string.IsNullOrEmpty(baseUrl)) baseUrl = ObservedOrigin;
        return string.IsNullOrEmpty(baseUrl) ? null : baseUrl + relative;
    }

    /// <summary>Modèles appliqués : ceux de la règle, sinon ceux par défaut (Alertes > Canaux), sinon les modèles intégrés.</summary>
    public (string Title, string Body) Templates(string? ruleTitle, string? ruleBody)
    {
        var s = settings.Current;
        return (Pick(ruleTitle, s.TitleTemplate, MessageTemplate.DefaultTitle), Pick(ruleBody, s.BodyTemplate, MessageTemplate.DefaultBody));

        static string Pick(params string?[] values) => values.First(v => !string.IsNullOrWhiteSpace(v))!;
    }

    /// <summary>Titre, corps et variables d'une notification.</summary>
    private sealed record Composed(string Title, MessageTemplate Body, Dictionary<string, string?> Vars, string? Link, string Status, string Severity);

    private Composed Compose(AlertNotification n)
    {
        var (titleTemplate, bodyTemplate) = Templates(n.TitleTemplate, n.BodyTemplate);
        var link = AbsoluteLink(n.Link);
        var vars = AlertVariables.Resolve(n, link);
        var title = MessageTemplate.Parse(titleTemplate).SingleLine(vars);
        if (string.IsNullOrWhiteSpace(title)) title = $"{AlertVariables.Status(n.Status, n.Severity)} : {n.RuleName}";
        return new Composed(title, MessageTemplate.Parse(bodyTemplate), vars, link, n.Status, n.Severity);
    }

    /// <summary>Rendu pour l'aperçu de l'éditeur de message.</summary>
    public MessagePreview Preview(AlertNotification n)
    {
        var c = Compose(n);
        return new MessagePreview(c.Title, c.Body.Html(c.Vars), c.Body.Slack(c.Vars), c.Body.Plain(c.Vars), c.Link, Tone(c));
    }

    /// <summary>good, warning ou attention (couleurs des cartes Teams).</summary>
    private static string Tone(Composed c) => c.Status is "resolved" or "test" ? "Good" : c.Severity == "warning" ? "Warning" : "Attention";

    private async Task PostAsync(string url, object payload, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw new FormatException("URL de webhook invalide.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        using var response = await http.CreateClient("notifications").PostAsJsonAsync(uri, payload, Json, timeout.Token);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Réponse {(int)response.StatusCode} du webhook");
    }

    private static readonly System.Text.Json.JsonSerializerOptions Json = new(System.Text.Json.JsonSerializerDefaults.Web)
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping, // accents lisibles dans les charges utiles
    };

    private static object Webhook(AlertNotification n, Composed c) => new
    {
        status = n.Status, rule = n.RuleName, severity = n.Severity, message = n.Message, link = c.Link, runbook = n.Runbook, at = n.At,
        title = c.Title, text = c.Body.Plain(c.Vars), variables = c.Vars,
    };

    private static object Slack(Composed c)
    {
        var text = $"*{c.Title}*\n{c.Body.Slack(c.Vars)}" + (c.Link is null ? "" : $"\n<{c.Link}|Voir dans Wolflog>");
        return new { text = c.Title, blocks = new object[] { new { type = "section", text = new { type = "mrkdwn", text } } } };
    }

    private static object Teams(Composed c)
    {
        var (blocks, mentions) = c.Body.Teams(c.Vars);
        var body = new List<object> { new { type = "TextBlock", text = c.Title, weight = "Bolder", size = "Medium", color = Tone(c), wrap = true } };
        body.AddRange(blocks);
        var card = new Dictionary<string, object>
        {
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["type"] = "AdaptiveCard",
            ["version"] = "1.4",
            ["body"] = body,
        };
        if (c.Link != null) card["actions"] = new object[] { new { type = "Action.OpenUrl", title = "Voir dans Wolflog", url = c.Link } };
        // Mentions @personne : entités attendues par Teams (identifiant = adresse ou id Entra ID).
        if (mentions.Count > 0) card["msteams"] = new { entities = mentions };
        return new { type = "message", attachments = new object[] { new { contentType = "application/vnd.microsoft.card.adaptive", content = card } } };
    }

    private async Task SendEmailAsync(AlertChannel channel, Composed c, CancellationToken ct)
    {
        var s = settings.Current;
        if (string.IsNullOrWhiteSpace(s.SmtpHost)) throw new InvalidOperationException("Serveur SMTP non configuré (Alertes > Canaux).");
        var recipients = channel.Target.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (recipients.Length == 0) throw new FormatException("Aucune adresse e-mail.");

        var html = new StringBuilder()
            .Append("<div style=\"font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1d2026\">")
            .Append($"<p style=\"font-size:16px;font-weight:600;margin:0 0 8px\">{WebUtility.HtmlEncode(c.Title)}</p>")
            .Append(c.Body.Html(c.Vars));
        if (c.Link != null) html.Append($"<p style=\"margin-top:12px\"><a href=\"{WebUtility.HtmlEncode(c.Link)}\">Voir dans Wolflog</a></p>");
        html.Append("</div>");

        using var message = new MailMessage
        {
            From = new MailAddress(string.IsNullOrWhiteSpace(s.From) ? "wolflog@localhost" : s.From, "Wolflog"),
            Subject = "[Wolflog] " + c.Title,
            Body = html.ToString(),
            IsBodyHtml = true,
            BodyEncoding = Encoding.UTF8,
            SubjectEncoding = Encoding.UTF8,
        };
        foreach (var r in recipients) message.To.Add(r);
        using var smtp = new SmtpClient(s.SmtpHost, s.SmtpPort) { EnableSsl = s.SmtpSsl, Timeout = 15_000 };
        if (!string.IsNullOrEmpty(s.SmtpUser)) smtp.Credentials = new NetworkCredential(s.SmtpUser, s.SmtpPassword);
        await smtp.SendMailAsync(message, ct);
    }
}
