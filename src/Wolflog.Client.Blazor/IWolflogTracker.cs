namespace Wolflog.Client.Blazor;

/// <summary>Mesure d'audience depuis le code C# d'une application Blazor Server (service « scoped » : un par circuit).</summary>
public interface IWolflogTracker
{
    /// <summary>
    /// Événement personnalisé : <c>await Tracker.TrackAsync("inscription", new { plan = "pro" })</c>.
    /// Une propriété <c>revenue</c> alimente le chiffre d'affaires de la page Audience.
    /// </summary>
    Task TrackAsync(string name, object? data = null);

    /// <summary>Page vue (appelée automatiquement par &lt;WolflogAnalytics /&gt; si TrackNavigation est activé).</summary>
    Task TrackPageviewAsync(string? url = null, string? title = null);

    /// <summary>Exception d'un composant (appelée par &lt;WolflogErrorBoundary&gt;).</summary>
    Task TrackErrorAsync(Exception exception, string? component = null);
}
