namespace Wolflog.Server.Sources;

public sealed class LogSourceStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<LogSource>(o.Value.ResolveDataDirectory(env.ContentRootPath), "sources.json");
