using Microsoft.AspNetCore.Components.Routing;

namespace Wolflog.Client.Blazor;

/// <summary>
/// À placer une fois dans un composant interactif (MainLayout.razor ou Routes.razor) : <c>&lt;WolflogAnalytics /&gt;</c>.
/// Ouvre le suivi du circuit et, si TrackNavigation est activé, mesure chaque navigation côté serveur.
/// </summary>
public sealed class WolflogAnalytics : ComponentBase, IDisposable
{
    [Inject] private NavigationManager Navigation { get; set; } = default!;
    [Inject] private IWolflogTracker Tracker { get; set; } = default!;
    [Inject] private VisitorContext Visitor { get; set; } = default!;
    [Inject] private IHttpContextAccessor Http { get; set; } = default!;
    [Inject] private IOptions<WolflogBlazorOptions> Options { get; set; } = default!;

    private bool _started;

    protected override void OnInitialized()
    {
        Visitor.Capture(Http.HttpContext);
        Visitor.MarkPreview(Navigation.Uri);
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        // OnAfterRender ne s'exécute qu'une fois le circuit interactif établi (jamais pendant le pré-rendu).
        if (!firstRender || _started || !Options.Value.TrackNavigation) return;
        _started = true;
        await Tracker.TrackPageviewAsync();
        Navigation.LocationChanged += OnLocationChanged;
    }

    private void OnLocationChanged(object? sender, LocationChangedEventArgs e) => _ = Tracker.TrackPageviewAsync(e.Location);

    public void Dispose() => Navigation.LocationChanged -= OnLocationChanged;
}
