namespace Wolflog.Server.Monitoring;

public sealed class ProbeStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<Probe>(o.Value.ResolveDataDirectory(env.ContentRootPath), "probes.json");
