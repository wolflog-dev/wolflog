// Commandes d'administration : install, uninstall, credentials, version, help.
if (args.Length > 0 && Installer.TryRun(args, out var exitCode))
    return exitCode;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
builder.AddWolflogServer();

var app = builder.Build();
app.UseWolflogServer();
app.Run();
return 0;

public partial class Program;
