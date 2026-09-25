using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Parsers;

namespace Vigil.Client.Profiling;

/// <summary>Résultat d'un profil : piles agrégées (« racine;…;feuille » → poids).</summary>
public sealed record ProfileResult(string Kind, DateTime Start, double Seconds, long Samples, IReadOnlyDictionary<string, long> Stacks);

/// <summary>
/// Profilage du processus courant par EventPipe (même mécanisme que dotnet-trace), sans outil externe :
/// « cpu » = échantillonnage des piles des threads qui exécutent du code ; « alloc » = allocations mémoire (≈ tous les 100 Ko).
/// </summary>
public static class Profiler
{
    private const string SampleProvider = "Microsoft-DotNETCore-SampleProfiler";
    private const string RuntimeProvider = "Microsoft-Windows-DotNETRuntime";

    public static async Task<ProfileResult> RunAsync(string kind, TimeSpan duration, CancellationToken ct)
    {
        var alloc = kind == "alloc";
        EventPipeProvider[] providers = alloc
            ? [new(RuntimeProvider, EventLevel.Verbose, (long)(ClrTraceEventParser.Keywords.GC | ClrTraceEventParser.Keywords.Loader | ClrTraceEventParser.Keywords.Jit))]
            : [new(SampleProvider, EventLevel.Informational), new(RuntimeProvider, EventLevel.Informational, (long)(ClrTraceEventParser.Keywords.Loader | ClrTraceEventParser.Keywords.Jit))];

        var file = Path.Combine(Path.GetTempPath(), $"vigil-profile-{Environment.ProcessId}-{Guid.NewGuid():N}.nettrace");
        var start = DateTime.UtcNow;
        try
        {
            var client = new DiagnosticsClient(Environment.ProcessId);
            using (var session = client.StartEventPipeSession(providers, requestRundown: true, circularBufferMB: 256))
            {
                await using var output = File.Create(file);
                var copy = session.EventStream.CopyToAsync(output, CancellationToken.None);
                try { await Task.Delay(duration, ct); }
                finally { await session.StopAsync(CancellationToken.None); }
                await copy;
            }
            return Aggregate(file, kind, start, (DateTime.UtcNow - start).TotalSeconds);
        }
        finally
        {
            TryDelete(file);
            TryDelete(Path.ChangeExtension(file, ".etlx"));
        }
    }

    /// <summary>Lit l'enregistrement et regroupe les piles d'appels identiques.</summary>
    internal static ProfileResult Aggregate(string nettrace, string kind, DateTime start, double seconds)
    {
        var alloc = kind == "alloc";
        var etlx = TraceLog.CreateFromEventPipeDataFile(nettrace);
        using var log = new TraceLog(etlx);
        var stacks = new Dictionary<string, long>();
        long samples = 0;
        foreach (var e in log.Events)
        {
            long weight;
            string? leaf = null;
            if (alloc)
            {
                if (e.ProviderName != RuntimeProvider || e.EventName != "GC/AllocationTick") continue;
                weight = e.PayloadByName("AllocationAmount64") is long amount ? amount : 100_000;
                leaf = e.PayloadByName("TypeName") as string;
            }
            else
            {
                if (e.ProviderName != SampleProvider) continue;
                // Type 1 = thread en attente ou dans du code natif (non compté comme CPU), 2 = code managé en cours d'exécution.
                if (SampleType(e) == 1) continue;
                weight = 1;
            }
            var stack = e.CallStack();
            if (stack is null) continue;
            var frames = new List<string>(32);
            if (leaf != null) frames.Add("[" + leaf + "]");
            for (var s = stack; s != null; s = s.Caller)
            {
                var name = s.CodeAddress.FullMethodName;
                if (string.IsNullOrEmpty(name)) name = s.CodeAddress.ModuleName is { Length: > 0 } m ? m + "!?" : "?";
                if (frames.Count > 0 && frames[^1] == name) continue; // récursion aplatie
                frames.Add(name);
                if (frames.Count > 200) break;
            }
            frames.Reverse(); // racine en premier
            var key = string.Join(';', frames);
            stacks[key] = stacks.GetValueOrDefault(key) + weight;
            samples++;
        }
        return new ProfileResult(kind, start, seconds, samples, stacks);
    }

    internal static int SampleType(TraceEvent e)
    {
        try
        {
            var value = e.PayloadByName("Type") ?? (e.PayloadNames.Length > 0 ? e.PayloadValue(0) : null);
            return value is null ? 0 : Convert.ToInt32(value);
        }
        catch (Exception ex) when (ex is FormatException or InvalidCastException or ArgumentException) { return 0; }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
