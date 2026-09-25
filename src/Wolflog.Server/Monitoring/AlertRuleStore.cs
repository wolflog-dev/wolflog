namespace Wolflog.Server.Monitoring;

public sealed class AlertRuleStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertRule>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-rules.json");
