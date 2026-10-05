using Microsoft.AspNetCore.Components.Server.Circuits;

namespace Wolflog.Client.Blazor;

/// <summary>Santé des circuits Blazor Server : coupures et reprises de la connexion SignalR, durée des circuits.</summary>
internal sealed class AnalyticsCircuitHandler(VisitorContext visitor, IWolflogTracker tracker, IHttpContextAccessor http, IOptions<WolflogBlazorOptions> options) : CircuitHandler
{
    private bool _down;

    public override Task OnCircuitOpenedAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        visitor.Capture(http.HttpContext, options.Value);
        return Task.CompletedTask;
    }

    public override Task OnConnectionDownAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        _down = true;
        return options.Value.TrackCircuits ? tracker.TrackAsync("blazor-disconnect") : Task.CompletedTask;
    }

    public override Task OnConnectionUpAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        visitor.Capture(http.HttpContext, options.Value);
        if (!_down) return Task.CompletedTask;
        _down = false;
        return options.Value.TrackCircuits ? tracker.TrackAsync("blazor-reconnect") : Task.CompletedTask;
    }

    public override Task OnCircuitClosedAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        if (!options.Value.TrackCircuits || visitor.CurrentUrl is null) return Task.CompletedTask;
        var seconds = (long)(DateTimeOffset.UtcNow - visitor.StartedAt).TotalSeconds;
        return tracker.TrackAsync("blazor-circuit-end", new { seconds });
    }
}
