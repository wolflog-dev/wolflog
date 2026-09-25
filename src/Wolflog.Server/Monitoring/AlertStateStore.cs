namespace Wolflog.Server.Monitoring;

public sealed class AlertStateStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertState>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-states.json");
