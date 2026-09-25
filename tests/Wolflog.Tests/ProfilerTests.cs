using System.Runtime.CompilerServices;
using Wolflog.Client.Profiling;

namespace Wolflog.Tests;

public class ProfilerTests
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static double BusyLoopForProfiler(TimeSpan duration)
    {
        var until = DateTime.UtcNow + duration;
        double x = 0;
        while (DateTime.UtcNow < until)
            for (var i = 1; i < 10_000; i++) x += Math.Sqrt(i) * Math.Sin(i);
        return x;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int AllocateForProfiler(TimeSpan duration)
    {
        var until = DateTime.UtcNow + duration;
        var kept = 0;
        while (DateTime.UtcNow < until)
        {
            var buffer = new byte[64 * 1024];
            kept += buffer.Length > 0 ? 1 : 0;
        }
        return kept;
    }

    [Fact]
    public async Task Cpu_profile_finds_the_busy_method()
    {
        var busy = Task.Run(() => BusyLoopForProfiler(TimeSpan.FromSeconds(4)));
        var result = await Profiler.RunAsync("cpu", TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        await busy;
        Assert.True(result.Samples > 50, $"{result.Samples} échantillons");
        var hot = result.Stacks.Where(kv => kv.Key.Contains(nameof(BusyLoopForProfiler))).Sum(kv => kv.Value);
        // D'autres tests tournent en parallèle : la méthode chaude doit peser, sans forcément dominer.
        Assert.True(hot > result.Samples / 20, $"{hot} sur {result.Samples}");
        var top = result.Stacks.OrderByDescending(kv => kv.Value).Take(5).Select(kv => kv.Key);
        Assert.Contains(top, k => k.Contains(nameof(BusyLoopForProfiler)));
    }

    [Fact]
    public async Task Allocation_profile_names_the_allocated_type()
    {
        var work = Task.Run(() => AllocateForProfiler(TimeSpan.FromSeconds(4)));
        var result = await Profiler.RunAsync("alloc", TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        await work;
        Assert.Contains(result.Stacks.Keys, k => k.Contains(nameof(AllocateForProfiler)) && k.EndsWith("[System.Byte[]]"));
    }
}
