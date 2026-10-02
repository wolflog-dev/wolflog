using Microsoft.AspNetCore.Authentication.Negotiate;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Wolflog.Server.Security;

/// <summary>Connexion unique réglée dans l'interface (Microsoft Entra ID, Windows) et clés de chiffrement des sessions.</summary>
public static class SsoServices
{
    /// <summary>Connexion Windows : la négociation Kerberos / NTLM n'a lieu que sur cette adresse.</summary>
    public const string WindowsPath = "/api/auth/windows";

    extension(IServiceCollection services)
    {
        public void AddSingleSignOn()
        {
            // Clés de chiffrement (cookies de session, état des connexions OpenID, secret client) dans le dossier de données :
            // elles survivent aux redémarrages, aux mises à jour d'un conteneur et aux comptes de service sans profil (Linux).
            // Nom fixe : les sessions restent valides si le binaire change de dossier. Sous Windows, chiffrées par DPAPI.
            var protection = services.AddDataProtection().SetApplicationName("Wolflog");
            if (OperatingSystem.IsWindows()) protection.ProtectKeysWithDpapi(protectToLocalMachine: true);
            services.AddSingleton<IConfigureOptions<KeyManagementOptions>>(sp => new ConfigureOptions<KeyManagementOptions>(o =>
            {
                var data = sp.GetRequiredService<IOptions<WolflogServerOptions>>().Value.ResolveDataDirectory(sp.GetRequiredService<IHostEnvironment>().ContentRootPath);
                o.XmlRepository = new FileSystemXmlRepository(new DirectoryInfo(Path.Combine(data, "data-protection")), sp.GetRequiredService<ILoggerFactory>());
            }));

            services.AddSingleton<SsoSettingsStore>();
            services.AddSingleton<SsoSchemes>();
            services.AddHttpClient("sso", c => c.Timeout = TimeSpan.FromSeconds(30));
            // Formulaire de connexion : compte local, sinon annuaire LDAP / Active Directory.
            services.AddSingleton<LdapDirectory>();
            services.AddSingleton<PasswordSignIn>();

            // Schémas inscrits à la demande par SsoSchemes : seules leurs options sont déclarées ici.
            services.TryAddEnumerable(ServiceDescriptor.Singleton<IPostConfigureOptions<OpenIdConnectOptions>, OpenIdConnectPostConfigureOptions>());
            services.TryAddEnumerable(ServiceDescriptor.Singleton<IPostConfigureOptions<NegotiateOptions>, PostConfigureNegotiateOptions>());
            services.AddOptions<OpenIdConnectOptions>(SsoSchemes.Microsoft)
                .Configure<SsoSettingsStore, NotificationSettingsStore, IHttpClientFactory>(OidcSignIn.ConfigureMicrosoft);
            services.AddOptions<NegotiateOptions>(SsoSchemes.Windows).Configure(o => o.Events = new NegotiateEvents
            {
                // Négociation en échec (identifiants refusés, keytab absent…) : sur /api/auth/windows, retour à la page de connexion
                // avec un message clair ; ailleurs, la requête continue simplement sans identité Windows.
                OnAuthenticationFailed = ctx =>
                {
                    if (!ctx.Request.Path.StartsWithSegments(WindowsPath))
                    {
                        ctx.SkipHandler();
                        return Task.CompletedTask;
                    }
                    ctx.HttpContext.RequestServices.GetRequiredService<SsoSettingsStore>().RecordFailure(SsoSchemes.Windows, ctx.Exception.Message);
                    ctx.Response.Redirect("/login?sso=windows");
                    ctx.HandleResponse();
                    return Task.CompletedTask;
                },
            });

            // Sous IIS, l'identité Windows ne remplace jamais la session Wolflog : sans cela, tout compte du domaine lirait l'API
            // sans compte Wolflog dès que l'authentification Windows du site est activée.
            services.Configure<IISServerOptions>(o => o.AutomaticAuthentication = false);
            services.Configure<IISOptions>(o => o.AutomaticAuthentication = false);
        }
    }

    extension(WebApplication app)
    {
        /// <summary>
        /// Avant l'authentification, sur les adresses de connexion : réglages appliqués (enregistrés, restaurés ou modifiés
        /// dans le fichier) pour que les schémas soient prêts dès cette requête, retour de Microsoft compris.
        /// </summary>
        public void UseSingleSignOn()
        {
            var sso = app.Services.GetRequiredService<SsoSchemes>();
            app.Use((ctx, next) =>
            {
                if (ctx.Request.Path.StartsWithSegments("/api/auth") || ctx.Request.Path.StartsWithSegments(OidcSignIn.CallbackPath)) sso.Sync(ctx);
                return next(ctx);
            });
        }
    }
}
