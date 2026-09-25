using System.IO.Compression;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.ResponseCompression;

namespace Wolflog.Server.Hosting;

/// <summary>Configuration et services du serveur, regroupés par domaine.</summary>
public static class ServerServices
{
    extension(WebApplicationBuilder builder)
    {
        public WebApplicationBuilder AddWolflogServer()
        {
            builder.AddLocalConfiguration();
            builder.Host.UseWindowsService(o => o.ServiceName = "Wolflog");
            builder.Host.UseSystemd();

            var services = builder.Services;
            services.Configure<WolflogServerOptions>(builder.Configuration.GetSection(WolflogServerOptions.Section));
            services.AddStorage();
            services.AddMonitoring();
            services.AddSources();
            services.AddGrpc(o =>
            {
                o.MaxReceiveMessageSize = 64 * 1024 * 1024;
                o.ResponseCompressionLevel = CompressionLevel.Fastest;
            });
            builder.AddSecurity();
            services.AddCompression();
            return builder;
        }

        /// <summary>Configuration locale (non écrasée par les mises à jour) : wolflog.json à côté du binaire, puis /etc/wolflog/wolflog.json.</summary>
        private void AddLocalConfiguration()
        {
            builder.Configuration.AddJsonFile(Path.Combine(AppContext.BaseDirectory, "wolflog.json"), optional: true, reloadOnChange: false);
            if (!OperatingSystem.IsWindows())
                builder.Configuration.AddJsonFile("/etc/wolflog/wolflog.json", optional: true, reloadOnChange: false);
            builder.Configuration.AddEnvironmentVariables("WOLFLOG_");
        }

        private void AddSecurity()
        {
            var options = builder.Configuration.GetSection(WolflogServerOptions.Section).Get<WolflogServerOptions>() ?? new WolflogServerOptions();
            builder.Services.AddSingleton<AuthService>();
            var authentication = builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
                .AddCookie(o =>
                {
                    o.Cookie.Name = "wolflog.auth";
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
            if (!string.IsNullOrWhiteSpace(options.Auth.Oidc.Authority))
                authentication.AddOpenIdConnect(SessionPrincipal.OidcScheme, o => SessionPrincipal.ConfigureOidc(o, options.Auth.Oidc));

            builder.Services.AddAuthorization(o =>
            {
                o.AddPolicy(Roles.Editor, p => p.RequireAssertion(ctx => Roles.Allows(ctx.User.FindFirst(ClaimTypes.Role)?.Value, Roles.Editor)));
                o.AddPolicy(Roles.Admin, p => p.RequireAssertion(ctx => Roles.Allows(ctx.User.FindFirst(ClaimTypes.Role)?.Value, Roles.Admin)));
            });
        }
    }

    extension(IServiceCollection services)
    {
        /// <summary>Stockage des signaux, requêtes et données de l'interface (tableaux, états des erreurs, déploiements, recherches).</summary>
        private void AddStorage()
        {
            services.AddSingleton<DataDirectoryLock>();
            services.AddSingleton<StorageHost>();
            services.AddHostedService(sp => sp.GetRequiredService<DataDirectoryLock>());
            services.AddHostedService(sp => sp.GetRequiredService<StorageHost>());
            services.AddSingleton<Ingestor>();
            services.AddScoped<QueryService>();
            services.AddSingleton<DashboardStore>();
            services.AddSingleton<ErrorStateStore>();
            services.AddSingleton<DeploymentStore>();
            services.AddSingleton<SavedSearchStore>();
        }

        /// <summary>Surveillance : alertes, sondes, SLO, profils, sauvegardes et santé de Wolflog.</summary>
        private void AddMonitoring()
        {
            services.AddSingleton<AlertRuleStore>();
            services.AddSingleton<AlertChannelStore>();
            services.AddSingleton<AlertStateStore>();
            services.AddSingleton<AlertEventStore>();
            services.AddSingleton<NotificationSettingsStore>();
            services.AddSingleton<ProbeStore>();
            services.AddSingleton<SloStore>();
            services.AddSingleton<ProfileStore>();
            services.AddSingleton<BackupState>();
            services.AddSingleton<HealthService>();
            services.AddSingleton<Notifier>();
            services.AddSingleton<ProbeEngine>();
            services.AddSingleton<AlertEngine>();
            // Une anomalie dans la surveillance ne doit jamais arrêter la réception des données.
            services.Configure<HostOptions>(o => o.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore);
            services.AddHostedService(sp => sp.GetRequiredService<ProbeEngine>());
            services.AddHostedService(sp => sp.GetRequiredService<AlertEngine>());
            services.AddHttpClient("notifications");
            services.AddHttpClient("probe").ConfigurePrimaryHttpMessageHandler(() => ProbeEngine.CreateHandler(ignoreTlsErrors: false));
            services.AddHttpClient("probe-insecure").ConfigurePrimaryHttpMessageHandler(() => ProbeEngine.CreateHandler(ignoreTlsErrors: true));
        }

        /// <summary>Sources lues directement par Wolflog : fichiers de logs et syslog.</summary>
        private void AddSources()
        {
            services.AddSingleton<LogSourceStore>();
            services.AddSingleton<SourceHost>();
            services.AddHostedService(sp => sp.GetRequiredService<SourceHost>());
        }

        private void AddCompression()
        {
            services.AddResponseCompression(o =>
            {
                o.EnableForHttps = true;
                o.Providers.Add<BrotliCompressionProvider>();
                o.Providers.Add<GzipCompressionProvider>();
                o.MimeTypes = ["application/json", "text/html", "text/css", "application/javascript", "image/svg+xml"];
            });
            services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
            services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
        }
    }
}
