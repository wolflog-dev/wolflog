using System.Diagnostics;
using OpenTelemetry;

namespace Wolflog.Client.Internal;

/// <summary>
/// Écarte les requêtes entrantes sur les chemins ignorés (/health…), quelle que soit la façon dont
/// l'activité a été captée : la source « * » écoute aussi Microsoft.AspNetCore, sans passer par le filtre
/// de l'instrumentation.
/// </summary>
internal sealed class IgnoredPathsProcessor(WolflogOptions options) : BaseProcessor<Activity>
{
    public override void OnEnd(Activity activity)
    {
        if (activity.Kind != ActivityKind.Server || options.IgnoredPaths.Count == 0) return;
        var path = activity.GetTagItem("url.path") as string;
        if (path is null) return;
        foreach (var ignored in options.IgnoredPaths)
        {
            if (Matches(path, ignored))
            {
                // Non enregistrée : l'exportateur ne la transmet pas.
                activity.ActivityTraceFlags &= ~ActivityTraceFlags.Recorded;
                return;
            }
        }
    }

    private static bool Matches(string path, string prefix) =>
        path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
        && (path.Length == prefix.Length || path[prefix.Length] == '/' || prefix.EndsWith('/'));
}
