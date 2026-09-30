using Microsoft.AspNetCore.Components.Web;

namespace Wolflog.Client.Blazor;

/// <summary>
/// ErrorBoundary qui signale les exceptions à Wolflog : événement d'audience « blazor-error » (par composant)
/// et log d'erreur (boîte de réception des erreurs si Wolflog.Client est installé).
/// <code>&lt;WolflogErrorBoundary Name="Commande"&gt;…&lt;/WolflogErrorBoundary&gt;</code>
/// </summary>
public class WolflogErrorBoundary : ErrorBoundary
{
    [Inject] private IWolflogTracker Tracker { get; set; } = default!;
    [Inject] private ILogger<WolflogErrorBoundary> Log { get; set; } = default!;

    /// <summary>Nom affiché dans Wolflog (ex. « Pages.Commande »).</summary>
    [Parameter] public string? Name { get; set; }

    protected override async Task OnErrorAsync(Exception exception)
    {
        Log.LogError(exception, "Exception dans le composant {Component}", Name ?? "Blazor");
        await Tracker.TrackErrorAsync(exception, Name);
        await base.OnErrorAsync(exception);
    }
}
