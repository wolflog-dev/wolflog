using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Routing;
using Microsoft.JSInterop;

namespace Wolflog.Client.Blazor;

/// <summary>
/// À placer une fois dans un composant interactif (MainLayout.razor ou Routes.razor) : <c>&lt;WolflogAnalytics /&gt;</c>.
/// Ouvre le suivi du circuit et, si TrackNavigation est activé, mesure chaque navigation côté serveur.
/// Avec TrackUsers, suit l'utilisateur connecté (connexion et déconnexion pendant le circuit comprises).
/// </summary>
public sealed class WolflogAnalytics : ComponentBase, IDisposable
{
    [Inject] private NavigationManager Navigation { get; set; } = default!;
    [Inject] private IWolflogTracker Tracker { get; set; } = default!;
    [Inject] private VisitorContext Visitor { get; set; } = default!;
    [Inject] private IHttpContextAccessor Http { get; set; } = default!;
    [Inject] private IOptions<WolflogBlazorOptions> Options { get; set; } = default!;
    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private IServiceProvider Services { get; set; } = default!;

    private bool _started;
    private bool _interactive;
    private AuthenticationStateProvider? _authentication;

    protected override async Task OnInitializedAsync()
    {
        Visitor.Capture(Http.HttpContext);
        Visitor.MarkPreview(Navigation.Uri);
        if (!Options.Value.TrackUsers) return;
        // Application sans authentification : pas de fournisseur, aucun utilisateur.
        _authentication = Services.GetService<AuthenticationStateProvider>();
        if (_authentication is null) return;
        _authentication.AuthenticationStateChanged += OnAuthenticationChanged;
        try { Visitor.User = (await _authentication.GetAuthenticationStateAsync()).User; }
        catch (InvalidOperationException) { /* état pas encore fourni : l'utilisateur de la requête HTTP reste valable */ }
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        // OnAfterRender ne s'exécute qu'une fois le circuit interactif établi (jamais pendant le pré-rendu).
        if (!firstRender) return;
        _interactive = true;
        await IdentifyBrowserAsync();
        if (_started || !Options.Value.TrackNavigation) return;
        _started = true;
        await Tracker.TrackPageviewAsync();
        Navigation.LocationChanged += OnLocationChanged;
    }

    private void OnLocationChanged(object? sender, LocationChangedEventArgs e) => _ = Tracker.TrackPageviewAsync(e.Location);

    private void OnAuthenticationChanged(Task<AuthenticationState> state) => _ = UserChangedAsync(state);

    private async Task UserChangedAsync(Task<AuthenticationState> state)
    {
        try
        {
            Visitor.User = (await state).User;
            if (_interactive) await InvokeAsync(IdentifyBrowserAsync);
        }
        catch (Exception ex) when (ex is InvalidOperationException or TaskCanceledException)
        {
            // Circuit fermé entre-temps : plus rien à mesurer.
        }
    }

    /// <summary>Script navigateur wolflog-rum.js présent dans la page : ses clics et événements sont rattachés au même utilisateur.</summary>
    private async Task IdentifyBrowserAsync()
    {
        if (!Options.Value.TrackUsers) return;
        try
        {
            await JS.InvokeVoidAsync("wolflog.identify", Options.Value.UserOf(Visitor.User));
        }
        catch (Exception ex) when (ex is JSException or JSDisconnectedException or InvalidOperationException or TaskCanceledException)
        {
            // Script navigateur absent (ou version sans identify), ou circuit fermé : rien à faire.
        }
    }

    public void Dispose()
    {
        Navigation.LocationChanged -= OnLocationChanged;
        if (_authentication is not null) _authentication.AuthenticationStateChanged -= OnAuthenticationChanged;
    }
}
