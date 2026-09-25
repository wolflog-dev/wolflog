namespace Wolflog.Server.Monitoring;

public sealed class NotificationSettingsStore(IOptions<WolflogServerOptions> o, IHostEnvironment env)
    : JsonCollection<NotificationSettings>(o.Value.ResolveDataDirectory(env.ContentRootPath), "notification-settings.json")
{
    public NotificationSettings Current => Get("mail") ?? new NotificationSettings();
}
