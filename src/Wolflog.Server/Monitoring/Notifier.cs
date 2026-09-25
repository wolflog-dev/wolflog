using System.Net;
using System.Net.Http.Json;
using System.Net.Mail;
using System.Text;

namespace Wolflog.Server.Monitoring;

public sealed record AlertNotification(
    string Status, string RuleName, string Severity, string Message, string? Link, string? Runbook, DateTime At);

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
                case "email": await SendEmailAsync(channel, n, ct); break;
                case "teams": await PostAsync(channel.Target, Teams(n), ct); break;
                case "slack": await PostAsync(channel.Target, Slack(n), ct); break;
                default: await PostAsync(channel.Target, Webhook(n), ct); break;
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

    private static string Title(AlertNotification n) => n.Status switch
    {
        "resolved" => $"Résolu : {n.RuleName}",
        "test" => $"Test Wolflog : {n.RuleName}",
        _ => (n.Severity == "warning" ? "Avertissement : " : "Alerte : ") + n.RuleName,
    };

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

    private object Webhook(AlertNotification n) => new
    {
        status = n.Status, rule = n.RuleName, severity = n.Severity, message = n.Message, link = AbsoluteLink(n.Link), runbook = n.Runbook, at = n.At,
        title = Title(n),
    };

    private object Slack(AlertNotification n)
    {
        var link = AbsoluteLink(n.Link);
        var text = $"*{Title(n)}*\n{n.Message}" + (n.Runbook is { Length: > 0 } r ? $"\nConsigne : {r}" : "") + (link is null ? "" : $"\n<{link}|Voir dans Wolflog>");
        return new { text = Title(n), blocks = new object[] { new { type = "section", text = new { type = "mrkdwn", text } } } };
    }

    private object Teams(AlertNotification n)
    {
        var link = AbsoluteLink(n.Link);
        var color = n.Status is "resolved" or "test" ? "Good" : n.Severity == "warning" ? "Warning" : "Attention";
        var body = new List<object>
        {
            new { type = "TextBlock", text = Title(n), weight = "Bolder", size = "Medium", color, wrap = true },
            new { type = "TextBlock", text = n.Message, wrap = true },
        };
        if (!string.IsNullOrEmpty(n.Runbook)) body.Add(new { type = "TextBlock", text = "Consigne : " + n.Runbook, wrap = true, isSubtle = true });
        body.Add(new { type = "TextBlock", text = n.At.ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss"), isSubtle = true, size = "Small" });
        var card = new Dictionary<string, object>
        {
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["type"] = "AdaptiveCard",
            ["version"] = "1.4",
            ["body"] = body,
        };
        if (link != null) card["actions"] = new object[] { new { type = "Action.OpenUrl", title = "Voir dans Wolflog", url = link } };
        return new { type = "message", attachments = new object[] { new { contentType = "application/vnd.microsoft.card.adaptive", content = card } } };
    }

    private async Task SendEmailAsync(AlertChannel channel, AlertNotification n, CancellationToken ct)
    {
        var s = settings.Current;
        if (string.IsNullOrWhiteSpace(s.SmtpHost)) throw new InvalidOperationException("Serveur SMTP non configuré (Alertes > Canaux).");
        var recipients = channel.Target.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (recipients.Length == 0) throw new FormatException("Aucune adresse e-mail.");

        var link = AbsoluteLink(n.Link);
        var html = new StringBuilder()
            .Append("<div style=\"font:14px/1.5 Segoe UI,Arial,sans-serif;color:#1d2026\">")
            .Append($"<p style=\"font-size:16px;font-weight:600;margin:0 0 8px\">{WebUtility.HtmlEncode(Title(n))}</p>")
            .Append($"<p style=\"margin:0 0 8px\">{WebUtility.HtmlEncode(n.Message)}</p>");
        if (!string.IsNullOrEmpty(n.Runbook)) html.Append($"<p style=\"margin:0 0 8px;color:#4b515c\">Consigne : {WebUtility.HtmlEncode(n.Runbook)}</p>");
        if (link != null) html.Append($"<p><a href=\"{WebUtility.HtmlEncode(link)}\">Voir dans Wolflog</a></p>");
        html.Append($"<p style=\"color:#858b96;font-size:12px\">{n.At.ToLocalTime():dd/MM/yyyy HH:mm:ss}</p></div>");

        using var message = new MailMessage
        {
            From = new MailAddress(string.IsNullOrWhiteSpace(s.From) ? "wolflog@localhost" : s.From, "Wolflog"),
            Subject = "[Wolflog] " + Title(n),
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
