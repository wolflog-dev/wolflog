using Microsoft.AspNetCore.HttpLogging;

namespace Wolflog.Client.Blazor;

/// <summary>
/// Journaux HTTP de l'application (app.UseHttpLogging(), corps compris) : rien pour les routes du relais /_wolflog, dont les corps
/// sont les mesures des visiteurs et les captures de page, même si le relais est placé après eux. Enregistré par AddWolflogBlazor().
/// </summary>
internal sealed class RelayHttpLogging : IHttpLoggingInterceptor
{
    public ValueTask OnRequestAsync(HttpLoggingInterceptorContext logContext)
    {
        if (logContext.HttpContext.Request.Path.StartsWithSegments(SiteRelay.Prefix, StringComparison.OrdinalIgnoreCase))
            logContext.LoggingFields = HttpLoggingFields.None;
        return ValueTask.CompletedTask;
    }

    public ValueTask OnResponseAsync(HttpLoggingInterceptorContext logContext) => ValueTask.CompletedTask;
}
