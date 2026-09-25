namespace Wolflog.Server.Monitoring;

public sealed class AlertEventStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<AlertEvent>(o.Value.ResolveDataDirectory(env.ContentRootPath), "alert-history.json")
{
    public void Add(AlertEvent e, int keep = 2000)
    {
        Upsert(e);
        var all = All();
        if (all.Count > keep + 100) ReplaceAll(all.OrderByDescending(x => x.At).Take(keep));
    }
}
