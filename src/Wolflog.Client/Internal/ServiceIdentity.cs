namespace Wolflog.Client.Internal;

/// <summary>Identité du service, partagée par OpenTelemetry et les rapports de crash.</summary>
internal sealed record ServiceIdentity(
    string Name, string Version, string Environment, string Host, string InstanceId, IReadOnlyDictionary<string, string> Extra)
{
    public IEnumerable<KeyValuePair<string, object>> Attributes()
    {
        yield return new("service.name", Name);
        yield return new("service.version", Version);
        yield return new("service.instance.id", InstanceId);
        yield return new("deployment.environment.name", Environment);
        yield return new("host.name", Host);
        yield return new("process.pid", (long)System.Environment.ProcessId);
        yield return new("process.runtime.name", ".NET");
        yield return new("process.runtime.version", System.Environment.Version.ToString());
        yield return new("os.type", OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsLinux() ? "linux" : OperatingSystem.IsMacOS() ? "darwin" : "other");
        foreach (var kv in Extra) yield return new(kv.Key, kv.Value);
    }
}
