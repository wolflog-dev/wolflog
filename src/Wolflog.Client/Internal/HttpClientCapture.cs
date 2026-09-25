namespace Wolflog.Client.Internal;

/// <summary>Capture pour les appels sortants (HttpClient), via l'enrichissement de l'instrumentation OpenTelemetry.</summary>
internal static class HttpClientCapture
{
    private const string PendingRequestBody = "wolflog.request.body";

    public static void OnRequest(HttpCaptureRules rules, Activity activity, HttpRequestMessage request)
    {
        var o = rules.Options;
        if (request.RequestUri is { Query.Length: > 1 } uri)
            activity.SetTag(HttpCaptureRules.RequestQuery, rules.Query(uri.Query));
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
