namespace Wolflog.Client.Blazor;

internal sealed class WolflogTracker(AnalyticsSender sender, VisitorContext visitor, NavigationManager navigation, IOptions<WolflogBlazorOptions> options) : IWolflogTracker
{
    private (string Path, string? Host)? Location(string? url)
    {
        try
        {
            var uri = url is null ? new Uri(navigation.Uri) : navigation.ToAbsoluteUri(url);
            return (uri.PathAndQuery, uri.Authority);
        }
        catch (InvalidOperationException)
        {
            // NavigationManager pas encore initialisé (hors composant) : dernière page connue.
            return visitor.CurrentUrl is { } current && Uri.TryCreate(current, UriKind.Absolute, out var abs) ? (abs.PathAndQuery, abs.Authority) : null;
        }
    }

    private Task Send(string type, string? url, string? title, string? name, object? data, string? referrer = null)
    {
        if (visitor.Preview || Location(url) is not { } location) return Task.CompletedTask;
        if (options.Value.ExcludedPaths.Any(p => location.Path.StartsWith(p, StringComparison.OrdinalIgnoreCase))) return Task.CompletedTask;
        sender.Enqueue(new AnalyticsEvent(type, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), location.Path, title, referrer, location.Host,
            name, data, visitor.Ip, visitor.UserAgent, visitor.Language, options.Value.UserOf(visitor.User)));
        return Task.CompletedTask;
    }

    public Task TrackAsync(string name, object? data = null) => Send("event", null, null, name, data);

    public Task TrackPageviewAsync(string? url = null, string? title = null)
    {
        var referrer = visitor.CurrentUrl ?? visitor.Referrer;
        var result = Send("pageview", url, title, null, null, referrer);
        try { visitor.CurrentUrl = url is null ? navigation.Uri : navigation.ToAbsoluteUri(url).ToString(); }
        catch (InvalidOperationException) { /* hors composant */ }
        return result;
    }

    public Task TrackErrorAsync(Exception exception, string? component = null)
    {
        var message = exception.Message.Length > 200 ? exception.Message[..200] : exception.Message;
        return Send("event", null, null, "blazor-error", new { type = exception.GetType().Name, message, component });
    }
}
