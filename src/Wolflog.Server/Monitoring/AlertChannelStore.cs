namespace Wolflog.Server.Monitoring;

public sealed class AlertChannelStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertChannel>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-channels.json");
