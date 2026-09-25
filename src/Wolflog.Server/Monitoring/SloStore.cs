namespace Wolflog.Server.Monitoring;

public sealed class SloStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<Slo>(o.Value.ResolveDataDirectory(env.ContentRootPath), "slos.json");
