using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Vigil.Client.Internal;

/// <summary>Masquage des données sensibles et mise en forme des corps capturés.</summary>
internal sealed class HttpCaptureRules
{
    public const string RequestBody = "http.request.body";
    public const string ResponseBody = "http.response.body";

    private readonly HashSet<string> _redactedHeaders;
    private readonly Regex? _jsonFields;
    private readonly Regex? _formFields;

    public HttpCaptureOptions Options { get; }

    public HttpCaptureRules(HttpCaptureOptions options)
    {
        Options = options;
        _redactedHeaders = new HashSet<string>(options.RedactedHeaders, StringComparer.OrdinalIgnoreCase);
        if (options.RedactedFields.Count > 0)
        {
            var names = string.Join("|", options.RedactedFields.Select(Regex.Escape));
            _jsonFields = new Regex($"(\"(?:{names})\"\\s*:\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"|[^,}}\\]\\s]+)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
            _formFields = new Regex($"((?:^|&)(?:{names})=)[^&]*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
        }
    }

    public bool ShouldKeepBodies(bool failed) => Options.Bodies == HttpBodyCapture.All || (Options.Bodies == HttpBodyCapture.Errors && failed);

    public string HeaderValue(string name, string value) => _redactedHeaders.Contains(name) ? "***" : value;

    public static bool IsTextual(string? contentType)
    {
        if (string.IsNullOrEmpty(contentType)) return false;
        var ct = contentType.ToLowerInvariant();
        if (ct.Contains("event-stream")) return false;
        return ct.StartsWith("text/") || ct.Contains("json") || ct.Contains("xml") || ct.Contains("x-www-form-urlencoded") || ct.Contains("graphql");
    }

    /// <summary>Décode les octets capturés, masque les champs sensibles et signale une éventuelle troncature.</summary>
    public string Format(ReadOnlySpan<byte> bytes, long totalLength, string? contentType)
    {
        var text = Encoding.UTF8.GetString(bytes);
        if (bytes.Length > 0 && text[^1] == '�') text = text[..^1]; // caractère coupé par la limite
        if (_jsonFields != null && contentType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true)
            text = _jsonFields.Replace(text, "$1\"***\"");
        else if (_formFields != null && contentType?.Contains("form-urlencoded", StringComparison.OrdinalIgnoreCase) == true)
            text = _formFields.Replace(text, "$1***");
        if (totalLength > bytes.Length) text += $"\n… [tronqué : {totalLength:N0} octets au total]";
        return text;
    }

    public static string Placeholder(string? contentType, long? length) =>
        $"[contenu non textuel : {contentType ?? "type inconnu"}{(length is > 0 ? $", {length:N0} octets" : "")}]";
}

/// <summary>Place le middleware de capture en tête du pipeline ASP.NET Core, sans action de l'application.</summary>
internal sealed class HttpCaptureStartupFilter(HttpCaptureRules rules, VigilOptions options) : IStartupFilter
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

/// <summary>Flux de réponse qui transmet tout et garde une copie des premiers octets.</summary>
internal sealed class CaptureStream(Stream inner, int limit) : Stream
{
    private readonly byte[] _buffer = new byte[limit];
    private int _captured;

    public long Total { get; private set; }
    public ReadOnlySpan<byte> Captured => _buffer.AsSpan(0, _captured);

    private void Keep(ReadOnlySpan<byte> data)
    {
        Total += data.Length;
        var room = _buffer.Length - _captured;
        if (room <= 0) return;
        var n = Math.Min(room, data.Length);
        data[..n].CopyTo(_buffer.AsSpan(_captured));
        _captured += n;
    }

    public override void Write(byte[] buffer, int offset, int count)
    {
        Keep(buffer.AsSpan(offset, count));
        inner.Write(buffer, offset, count);
    }

    public override void Write(ReadOnlySpan<byte> buffer)
    {
        Keep(buffer);
        inner.Write(buffer);
    }

    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct)
    {
        Keep(buffer.AsSpan(offset, count));
        return inner.WriteAsync(buffer, offset, count, ct);
    }

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        Keep(buffer.Span);
        return inner.WriteAsync(buffer, ct);
    }

    public override void Flush() => inner.Flush();
    public override Task FlushAsync(CancellationToken ct) => inner.FlushAsync(ct);
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => Total; set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
}

/// <summary>Capture pour les appels sortants (HttpClient), via l'enrichissement de l'instrumentation OpenTelemetry.</summary>
internal static class HttpClientCapture
{
    private const string PendingRequestBody = "vigil.request.body";

    public static void OnRequest(HttpCaptureRules rules, Activity activity, HttpRequestMessage request)
    {
        var o = rules.Options;
        if (o.Headers)
        {
            foreach (var (name, values) in request.Headers)
                activity.SetTag("http.request.header." + name.ToLowerInvariant(), rules.HeaderValue(name, string.Join(", ", values)));
            if (request.Content != null)
                foreach (var (name, values) in request.Content.Headers)
                    activity.SetTag("http.request.header." + name.ToLowerInvariant(), rules.HeaderValue(name, string.Join(", ", values)));
        }
        if (o.Bodies == HttpBodyCapture.Off || request.Content is null) return;

        var ct = request.Content.Headers.ContentType?.ToString();
        string body;
        // Les contenus déjà en mémoire (JSON, texte, formulaire) sont lisibles sans effet de bord ; pas les flux.
        if (HttpCaptureRules.IsTextual(ct) && request.Content is not StreamContent)
        {
            var bytes = request.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
            body = rules.Format(bytes.AsSpan(0, Math.Min(bytes.Length, o.MaxBodyBytes)), bytes.Length, ct);
        }
        else
        {
            body = HttpCaptureRules.Placeholder(ct, request.Content.Headers.ContentLength);
        }
        if (o.Bodies == HttpBodyCapture.All) activity.SetTag(HttpCaptureRules.RequestBody, body);
        else activity.SetCustomProperty(PendingRequestBody, body); // décidé à la réponse
    }

    public static void OnResponse(HttpCaptureRules rules, Activity activity, HttpResponseMessage response)
    {
        var o = rules.Options;
        if (o.Headers)
        {
            foreach (var (name, values) in response.Headers)
                activity.SetTag("http.response.header." + name.ToLowerInvariant(), rules.HeaderValue(name, string.Join(", ", values)));
            foreach (var (name, values) in response.Content.Headers)
                activity.SetTag("http.response.header." + name.ToLowerInvariant(), rules.HeaderValue(name, string.Join(", ", values)));
        }
        var failed = (int)response.StatusCode >= 400;
        if (!rules.ShouldKeepBodies(failed)) return;
        KeepPendingRequestBody(activity);

        var ct = response.Content.Headers.ContentType?.ToString();
        var length = response.Content.Headers.ContentLength;
        // Lecture seulement si la taille est connue et raisonnable : le contenu est mis en mémoire tampon
        // et reste lisible normalement par l'application ensuite.
        if (HttpCaptureRules.IsTextual(ct) && length is > 0 && length <= o.MaxBodyBytes * 4L)
        {
            response.Content.LoadIntoBufferAsync().GetAwaiter().GetResult();
            var bytes = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
            activity.SetTag(HttpCaptureRules.ResponseBody, rules.Format(bytes.AsSpan(0, Math.Min(bytes.Length, o.MaxBodyBytes)), bytes.Length, ct));
        }
        else if (length is > 0)
        {
            activity.SetTag(HttpCaptureRules.ResponseBody, HttpCaptureRules.IsTextual(ct)
                ? $"[réponse de {length:N0} octets non capturée : au-delà de la limite]"
                : HttpCaptureRules.Placeholder(ct, length));
        }
    }

    public static void OnException(HttpCaptureRules rules, Activity activity)
    {
        if (rules.Options.Bodies != HttpBodyCapture.Off) KeepPendingRequestBody(activity);
    }

    private static void KeepPendingRequestBody(Activity activity)
    {
        if (activity.GetCustomProperty(PendingRequestBody) is string body)
            activity.SetTag(HttpCaptureRules.RequestBody, body);
    }
}
