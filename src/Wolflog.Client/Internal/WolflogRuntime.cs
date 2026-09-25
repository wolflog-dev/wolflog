namespace Wolflog.Client.Internal;

/// <summary>Accès statique au conteneur (utilisé par le sink Serilog créé avant l'hôte).</summary>
internal static class WolflogRuntime
{
    public static IServiceProvider? Services { get; private set; }
    public static event Action<IServiceProvider>? Started;
    public static void RaiseStarted(IServiceProvider sp)
    {
        Services = sp;
        Started?.Invoke(sp);
    }
}
