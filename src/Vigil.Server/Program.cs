using System.IO.Compression;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.FileProviders;
using Vigil.Server;
using Vigil.Server.Api;
using Vigil.Server.Hosting;
using Vigil.Server.Ingestion;
using Vigil.Server.Monitoring;
using Vigil.Server.Query;
using Vigil.Server.Security;
using Vigil.Server.Storage;

// Commandes d'administration : install, uninstall, credentials, version, help.
if (args.Length > 0 && Installer.TryRun(args, out var exitCode))
    return exitCode;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});

// Configuration locale (non écrasée par les mises à jour) : vigil.json à côté du binaire, puis /etc/vigil/vigil.json.
builder.Configuration.AddJsonFile(Path.Combine(AppContext.BaseDirectory, "vigil.json"), optional: true, reloadOnChange: false);
if (!OperatingSystem.IsWindows())
    builder.Configuration.AddJsonFile("/etc/vigil/vigil.json", optional: true, reloadOnChange: false);
builder.Configuration.AddEnvironmentVariables("VIGIL_");

builder.Host.UseWindowsService(o => o.ServiceName = "Vigil");
builder.Host.UseSystemd();

builder.Services.Configure<VigilServerOptions>(builder.Configuration.GetSection(VigilServerOptions.Section));
builder.Services.AddSingleton<DataDirectoryLock>();
builder.Services.AddSingleton<StorageHost>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DataDirectoryLock>());
builder.Services.AddHostedService(sp => sp.GetRequiredService<StorageHost>());
builder.Services.AddSingleton<AuthService>();
builder.Services.AddSingleton<Ingestor>();
builder.Services.AddScoped<QueryService>();
builder.Services.AddSingleton<Vigil.Server.Dashboards.DashboardStore>();
builder.Services.AddSingleton<Vigil.Server.Configuration.ErrorStateStore>();
builder.Services.AddSingleton<Vigil.Server.Configuration.DeploymentStore>();
builder.Services.AddSingleton<Vigil.Server.Configuration.SavedSearchStore>();

// Surveillance : alertes, sondes, SLO, santé de Vigil.
builder.Services.AddSingleton<AlertRuleStore>();
builder.Services.AddSingleton<AlertChannelStore>();
builder.Services.AddSingleton<AlertStateStore>();
builder.Services.AddSingleton<AlertEventStore>();
builder.Services.AddSingleton<NotificationSettingsStore>();
builder.Services.AddSingleton<ProbeStore>();
builder.Services.AddSingleton<SloStore>();
builder.Services.AddSingleton<BackupState>();
builder.Services.AddSingleton<HealthService>();
builder.Services.AddSingleton<Notifier>();
builder.Services.AddSingleton<ProbeEngine>();
builder.Services.AddSingleton<AlertEngine>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ProbeEngine>());
builder.Services.AddHostedService(sp => sp.GetRequiredService<AlertEngine>());
builder.Services.AddHttpClient("notifications");
builder.Services.AddHttpClient("probe").ConfigurePrimaryHttpMessageHandler(() => ProbeEngine.CreateHandler(ignoreTlsErrors: false));
builder.Services.AddHttpClient("probe-insecure").ConfigurePrimaryHttpMessageHandler(() => ProbeEngine.CreateHandler(ignoreTlsErrors: true));

builder.Services.AddGrpc(o =>
{
    o.MaxReceiveMessageSize = 64 * 1024 * 1024;
    o.ResponseCompressionLevel = CompressionLevel.Fastest;
});

var serverOptions = builder.Configuration.GetSection(VigilServerOptions.Section).Get<VigilServerOptions>() ?? new VigilServerOptions();
var authentication = builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.Cookie.Name = "vigil.auth";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax; // Lax : nécessaire au retour du SSO
        o.ExpireTimeSpan = TimeSpan.FromDays(7);
        o.SlidingExpiration = true;
        // API : 401 au lieu d'une redirection vers une page de login.
        o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; };
        // Compte désactivé ou rôle modifié : pris en compte immédiatement, sans attendre l'expiration du cookie.
        o.Events.OnValidatePrincipal = SessionPrincipal.Refresh;
    });
if (!string.IsNullOrWhiteSpace(serverOptions.Auth.Oidc.Authority))
    authentication.AddOpenIdConnect(SessionPrincipal.OidcScheme, o => SessionPrincipal.ConfigureOidc(o, serverOptions.Auth.Oidc));

builder.Services.AddAuthorization(o =>
{
    o.AddPolicy(Roles.Editor, p => p.RequireAssertion(ctx => Roles.Allows(ctx.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value, Roles.Editor)));
    o.AddPolicy(Roles.Admin, p => p.RequireAssertion(ctx => Roles.Allows(ctx.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value, Roles.Admin)));
});

builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.Providers.Add<BrotliCompressionProvider>();
    o.Providers.Add<GzipCompressionProvider>();
    o.MimeTypes = ["application/json", "text/html", "text/css", "application/javascript", "image/svg+xml"];
});
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);

var app = builder.Build();

// Vérifie les identifiants dès le démarrage (et les affiche au premier lancement).
var auth = app.Services.GetRequiredService<AuthService>();

app.UseResponseCompression();

// Ingestion OTLP : contrôle de la clé API (HTTP /v1/* et services gRPC).
app.Use(async (ctx, next) =>
{
    var path = ctx.Request.Path;
    var isIngest = path.StartsWithSegments("/v1") || path.StartsWithSegments("/opentelemetry.proto.collector");
    if (isIngest && !path.StartsWithSegments("/v1/rum"))
    {
        var key = auth.ValidateApiKey(AuthService.ReadApiKey(ctx.Request.Headers));
        // Une clé "navigateur" est publique (visible dans la page) : elle ne sert qu'à l'envoi RUM.
        if (key is null || key.Kind != "server")
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
    }
    await next();
});

app.UseAuthentication();
app.UseAuthorization();

var ingestor = app.Services.GetRequiredService<Ingestor>();
app.MapPost("/v1/logs", (Func<HttpContext, Task<IResult>>)ingestor.HandleLogs).AllowAnonymous();
app.MapPost("/v1/traces", (Func<HttpContext, Task<IResult>>)ingestor.HandleTraces).AllowAnonymous();
app.MapPost("/v1/metrics", (Func<HttpContext, Task<IResult>>)ingestor.HandleMetrics).AllowAnonymous();
app.MapGrpcService<LogsGrpcService>().AllowAnonymous();
app.MapGrpcService<TraceGrpcService>().AllowAnonymous();
app.MapGrpcService<MetricsGrpcService>().AllowAnonymous();

app.MapVigilApi();

// Interface Angular : embarquée dans le binaire (ou dossier wwwroot physique s'il existe, pratique en dev).
var ui = UiFiles.Create(app.Environment, app.Logger);
if (ui != null)
{
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = ui });
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = ui,
        OnPrepareResponse = ctx =>
        {
            // Les fichiers générés par Angular ont un hash dans leur nom : cache long. index.html : jamais en cache.
            ctx.Context.Response.Headers.CacheControl = ctx.File.Name == "index.html" ? "no-cache" : "public, max-age=31536000, immutable";
        },
    });
    app.MapFallback(async ctx =>
    {
        if (ctx.Request.Path.StartsWithSegments("/api") || ctx.Request.Path.StartsWithSegments("/v1"))
        {
            ctx.Response.StatusCode = 404;
            return;
        }
        var index = ui.GetFileInfo("index.html");
        ctx.Response.ContentType = "text/html; charset=utf-8";
        ctx.Response.Headers.CacheControl = "no-cache";
        await using var s = index.CreateReadStream();
        await s.CopyToAsync(ctx.Response.Body);
    }).AllowAnonymous();
}
else
{
    app.MapGet("/", () => Results.Text("Vigil est démarré, mais l'interface n'a pas été construite (dossier ui/).", "text/plain; charset=utf-8"));
}

app.Run();
return 0;

public partial class Program;

internal static class UiFiles
{
    public static IFileProvider? Create(IWebHostEnvironment env, ILogger log)
    {
        var physical = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (File.Exists(Path.Combine(physical, "index.html"))) return new PhysicalFileProvider(physical);
        try
        {
            var embedded = new ManifestEmbeddedFileProvider(typeof(Program).Assembly, "wwwroot");
            if (embedded.GetFileInfo("index.html").Exists) return embedded;
        }
        catch (InvalidOperationException) { }
        log.LogWarning("Interface web absente : lancez 'npm run build' dans ui/ puis recompilez.");
        return null;
    }
}
