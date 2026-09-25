// Banc d'essai : envoie des logs OTLP en parallèle à un serveur Wolflog, puis mesure quelques requêtes.
//   dotnet run -c Release --project tests/Wolflog.Bench -- --url http://localhost:5080 --key <clé> --password <mdp>
using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Google.Protobuf;
using OpenTelemetry.Proto.Collector.Logs.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;
using OpenTelemetry.Proto.Resource.V1;

var opts = Args.Parse(args);
Console.WriteLine($"Cible {opts.Url} · {opts.Seconds} s · {opts.Concurrency} envois parallèles · lots de {opts.Batch} logs");

// Quelques lots différents, sérialisés et compressés une seule fois (on mesure le serveur, pas le client).
var payloads = Enumerable.Range(0, 16).Select(i => Gzip(BuildBatch(opts.Batch, i).ToByteArray())).ToArray();
Console.WriteLine($"Lot compressé : {payloads[0].Length / 1024.0:F1} Ko");

using var http = new HttpClient(new SocketsHttpHandler { MaxConnectionsPerServer = opts.Concurrency * 2 }) { BaseAddress = new Uri(opts.Url) };
long rows = 0, bytes = 0, errors = 0;
var latencies = new List<double>();
var latLock = new Lock();
var stop = DateTime.UtcNow.AddSeconds(opts.Seconds);
var sw = Stopwatch.StartNew();

await Task.WhenAll(Enumerable.Range(0, opts.Concurrency).Select(async worker =>
{
    var i = worker;
    while (DateTime.UtcNow < stop)
    {
        var body = payloads[i++ % payloads.Length];
        using var content = new ByteArrayContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        content.Headers.ContentEncoding.Add("gzip");
        using var request = new HttpRequestMessage(HttpMethod.Post, "v1/logs") { Content = content };
        if (opts.Key != null) request.Headers.Add("x-wolflog-key", opts.Key);
        var t = Stopwatch.GetTimestamp();
        try
        {
            using var response = await http.SendAsync(request);
            if (response.IsSuccessStatusCode)
            {
                Interlocked.Add(ref rows, opts.Batch);
                Interlocked.Add(ref bytes, body.Length);
            }
            else Interlocked.Increment(ref errors);
        }
        catch (HttpRequestException) { Interlocked.Increment(ref errors); }
        var ms = Stopwatch.GetElapsedTime(t).TotalMilliseconds;
        lock (latLock) latencies.Add(ms);
    }
}));
sw.Stop();

latencies.Sort();
double P(double q) => latencies.Count == 0 ? 0 : latencies[(int)Math.Min(latencies.Count - 1, q * latencies.Count)];
Console.WriteLine();
Console.WriteLine($"Ingestion : {rows:N0} logs en {sw.Elapsed.TotalSeconds:F1} s = {rows / sw.Elapsed.TotalSeconds:N0} logs/s " +
                  $"({bytes / sw.Elapsed.TotalSeconds / 1024 / 1024:F1} Mo/s compressés), erreurs : {errors}");
Console.WriteLine($"Latence par lot : p50 {P(0.5):F1} ms · p95 {P(0.95):F1} ms · p99 {P(0.99):F1} ms");

if (opts.Password is null && opts.Key is not null)
{
    Console.WriteLine("(--password non fourni : mesures de requêtes ignorées)");
    return;
}

// Requêtes typiques de l'interface.
var cookies = new CookieContainer();
using var api = new HttpClient(new HttpClientHandler { CookieContainer = cookies }) { BaseAddress = new Uri(opts.Url) };
if (opts.Password != null)
    (await api.PostAsJsonAsync("api/auth/login", new { username = "admin", password = opts.Password })).EnsureSuccessStatusCode();
await api.PostAsync("api/system/flush", null);

Console.WriteLine();
foreach (var (label, url) in new[]
{
    ("Derniers logs (200)", "api/logs?from=1h&limit=200"),
    ("Histogramme 1 h", "api/logs/histogram?from=1h"),
    ("Recherche texte « paiement »", "api/logs?from=1h&q=paiement&limit=200"),
    ("Terme absent (élagage)", "api/logs?from=1h&q=zzqxj&limit=200"),
    ("Erreurs uniquement", "api/logs?from=1h&level=error&limit=200"),
    ("Filtre attribut", "api/logs?from=1h&q=http.route:/orders/*&limit=200"),
    ("Regroupement des erreurs", "api/errors?from=1h"),
    ("Vue d'ensemble", "api/overview?from=1h"),
})
{
    await api.GetAsync(url); // préchauffage
    var t = Stopwatch.StartNew();
    const int runs = 5;
    for (var r = 0; r < runs; r++) (await api.GetAsync(url)).EnsureSuccessStatusCode();
    Console.WriteLine($"{label,-32} {t.Elapsed.TotalMilliseconds / runs,8:F1} ms");
}

static ExportLogsServiceRequest BuildBatch(int count, int seed)
{
    var rnd = new Random(seed);
    var now = (ulong)(DateTime.UtcNow - DateTime.UnixEpoch).Ticks * 100;
    string[] routes = ["/orders/{id}", "/stock/{id}", "/customers/{id}", "/payments"];
    string[] words = ["commande", "paiement", "client", "stock", "livraison", "facture", "panier", "remise"];
    var scope = new ScopeLogs { Scope = new InstrumentationScope { Name = "Bench.Orders" } };
    for (var i = 0; i < count; i++)
    {
        var error = rnd.Next(100) < 3;
        var r = new LogRecord
        {
            TimeUnixNano = now + (ulong)i * 1000,
            SeverityNumber = error ? SeverityNumber.Error : SeverityNumber.Info,
            Body = new AnyValue { StringValue = $"Traitement {words[rnd.Next(words.Length)]} {rnd.Next(100000)} en {rnd.Next(1, 500)} ms pour le client {rnd.Next(10000)}" },
            TraceId = ByteString.CopyFrom(Guid.NewGuid().ToByteArray()),
            SpanId = ByteString.CopyFrom(BitConverter.GetBytes(rnd.NextInt64())),
        };
        r.Attributes.Add(new KeyValue { Key = "http.route", Value = new AnyValue { StringValue = routes[rnd.Next(routes.Length)] } });
        r.Attributes.Add(new KeyValue { Key = "user.id", Value = new AnyValue { IntValue = rnd.Next(10000) } });
        if (error)
        {
            r.Attributes.Add(new KeyValue { Key = "exception.type", Value = new AnyValue { StringValue = "System.TimeoutException" } });
            r.Attributes.Add(new KeyValue { Key = "exception.message", Value = new AnyValue { StringValue = "Délai dépassé" } });
            r.Attributes.Add(new KeyValue { Key = "exception.stacktrace", Value = new AnyValue { StringValue = "System.TimeoutException: Délai dépassé\n   at Bench.Payments.Charge() in /src/Payments.cs:line 42" } });
        }
        scope.LogRecords.Add(r);
    }
    var resource = new Resource();
    resource.Attributes.Add(new KeyValue { Key = "service.name", Value = new AnyValue { StringValue = $"bench-{seed % 4}" } });
    resource.Attributes.Add(new KeyValue { Key = "host.name", Value = new AnyValue { StringValue = "bench-host" } });
    return new ExportLogsServiceRequest { ResourceLogs = { new ResourceLogs { Resource = resource, ScopeLogs = { scope } } } };
}

static byte[] Gzip(byte[] data)
{
    using var ms = new MemoryStream();
    using (var gz = new GZipStream(ms, CompressionLevel.Fastest)) gz.Write(data);
    return ms.ToArray();
}
