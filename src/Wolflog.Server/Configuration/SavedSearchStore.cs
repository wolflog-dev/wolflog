namespace Wolflog.Server.Configuration;

public sealed class SavedSearchStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<SavedSearch>(o.Value.ResolveDataDirectory(env.ContentRootPath), "saved-searches.json");
