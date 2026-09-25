namespace Wolflog.Server.Security;

/// <summary>Ingestion OTLP (HTTP /v1/* et services gRPC) : exige une clé API de type « serveur ».</summary>
public sealed class IngestKeyMiddleware(RequestDelegate next, AuthService auth)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path;
        var isIngest = path.StartsWithSegments("/v1") || path.StartsWithSegments("/opentelemetry.proto.collector");
        if (isIngest && !path.StartsWithSegments("/v1/rum"))
        {
            var key = auth.ValidateApiKey(AuthService.ReadApiKey(ctx.Request.Headers));
            // Une clé « navigateur » est publique (visible dans la page) : elle ne sert qu'à l'envoi RUM.
            if (key is null || key.Kind != "server")
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
        }
        await next(ctx);
    }
}
