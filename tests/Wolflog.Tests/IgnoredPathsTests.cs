namespace Wolflog.Tests;

public class IgnoredPathsTests
{
    [Theory]
    [InlineData("/health", false)]
    [InlineData("/health/ready", false)]
    [InlineData("/healthy", true)]
    [InlineData("/api/orders", true)]
    public void Ignored_paths_are_not_exported(string path, bool exported)
    {
        using var source = new System.Diagnostics.ActivitySource("test-ignored-paths");
        using var listener = new System.Diagnostics.ActivityListener
        {
            ShouldListenTo = s => s.Name == "test-ignored-paths",
            Sample = (ref System.Diagnostics.ActivityCreationOptions<System.Diagnostics.ActivityContext> _) => System.Diagnostics.ActivitySamplingResult.AllDataAndRecorded,
        };
        System.Diagnostics.ActivitySource.AddActivityListener(listener);
        using var activity = source.StartActivity("GET", System.Diagnostics.ActivityKind.Server)!;
        activity.SetTag("url.path", path);
        new Wolflog.Client.Internal.IgnoredPathsProcessor(new Wolflog.Client.WolflogOptions()).OnEnd(activity);
        Assert.Equal(exported, activity.Recorded);
    }
}
