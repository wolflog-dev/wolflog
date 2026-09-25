using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Wolflog.Client.Internal;

/// <summary>Place le middleware de capture en tête du pipeline ASP.NET Core, sans action de l'application.</summary>
internal sealed class HttpCaptureStartupFilter(HttpCaptureRules rules, WolflogOptions options) : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use((ctx, nextMiddleware) => Capture(ctx, nextMiddleware));
        next(app);
    };

    private async Task Capture(HttpContext ctx, RequestDelegate next)
    {
        var activity = Activity.Current;
        if (activity is null || !activity.IsAllDataRequested || IsIgnored(ctx) || IsStreaming(ctx))
        {
            await next(ctx);
            return;
        }

        var o = rules.Options;
        string? requestBody = null;
        CaptureStream? responseCapture = null;
        Stream? originalBody = null;

        if (o.Bodies != HttpBodyCapture.Off)
        {
            var request = ctx.Request;
            if (request.ContentLength is > 0 || request.Headers.TransferEncoding.Count > 0)
            {
                if (HttpCaptureRules.IsTextual(request.ContentType))
                {
                    request.EnableBuffering();
                    var buffer = new byte[o.MaxBodyBytes];
                    var read = await request.Body.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, ctx.RequestAborted);
                    long total = read;
                    if (read == buffer.Length) total = request.ContentLength ?? read + 1;
                    request.Body.Position = 0;
                    requestBody = rules.Format(buffer.AsSpan(0, read), total, request.ContentType);
                }
                else
                {
                    requestBody = HttpCaptureRules.Placeholder(request.ContentType, request.ContentLength);
                }
            }

            originalBody = ctx.Response.Body;
            responseCapture = new CaptureStream(originalBody, o.MaxBodyBytes);
            ctx.Response.Body = responseCapture;
        }

        var failed = false;
        try
        {
            await next(ctx);
        }
        catch
        {
            failed = true;
            throw;
        }
        finally
        {
            if (originalBody != null) ctx.Response.Body = originalBody;
            failed |= ctx.Response.StatusCode >= 400;

            if (ctx.Request.QueryString.HasValue)
                activity.SetTag(HttpCaptureRules.RequestQuery, rules.Query(ctx.Request.QueryString.Value!));
            if (o.Headers)
            {
                foreach (var (name, value) in ctx.Request.Headers)
                    activity.SetTag("http.request.header." + name.ToLowerInvariant(), rules.HeaderValue(name, value.ToString()));
                foreach (var (name, value) in ctx.Response.Headers)
                    activity.SetTag("http.response.header." + name.ToLowerInvariant(), rules.HeaderValue(name, value.ToString()));
            }
            if (rules.ShouldKeepBodies(failed))
            {
                if (requestBody != null) activity.SetTag(HttpCaptureRules.RequestBody, requestBody);
                if (responseCapture is { Total: > 0 })
                {
                    var ct = ctx.Response.ContentType;
                    activity.SetTag(HttpCaptureRules.ResponseBody, HttpCaptureRules.IsTextual(ct)
                        ? rules.Format(responseCapture.Captured, responseCapture.Total, ct)
                        : HttpCaptureRules.Placeholder(ct, responseCapture.Total));
                }
            }
        }
    }

    private bool IsIgnored(HttpContext ctx) =>
        options.IgnoredPaths.Any(p => ctx.Request.Path.StartsWithSegments(p, StringComparison.OrdinalIgnoreCase));

    private static bool IsStreaming(HttpContext ctx) =>
        ctx.WebSockets.IsWebSocketRequest || ctx.Request.Headers.Accept.ToString().Contains("text/event-stream", StringComparison.OrdinalIgnoreCase);
}
