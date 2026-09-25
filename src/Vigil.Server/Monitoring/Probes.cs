using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Options;
using OpenTelemetry.Proto.Collector.Metrics.V1;
using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Metrics.V1;
using OpenTelemetry.Proto.Resource.V1;
using Vigil.Server.Configuration;
using Vigil.Server.Ingestion;

namespace Vigil.Server.Monitoring;

/// <summary>Sonde de disponibilité : appel HTTP(S) ou connexion TCP à intervalle régulier.</summary>
public sealed class Probe : IEntity
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    /// <summary>http ou tcp.</summary>
    public string Type { get; set; } = "http";
    /// <summary>URL (http) ou hôte:port (tcp).</summary>
    public string Target { get; set; } = "";
    public string Method { get; set; } = "GET";
    public int IntervalSeconds { get; set; } = 60;
    public int TimeoutSeconds { get; set; } = 10;
    /// <summary>Codes acceptés, ex. "200-399" ou "200,204".</summary>
    public string ExpectedStatus { get; set; } = "200-399";
    /// <summary>Texte qui doit apparaître dans la réponse (facultatif).</summary>
    public string? ExpectedText { get; set; }
    /// <summary>Échecs consécutifs avant de considérer la cible en panne.</summary>
    public int FailuresBeforeDown { get; set; } = 2;
    /// <summary>Service associé (pour relier la sonde aux logs et traces).</summary>
    public string? Service { get; set; }
    public bool IgnoreTlsErrors { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class ProbeStore(IOptions<VigilServerOptions> o, IHostEnvironment env)
    : JsonCollection<Probe>(o.Value.ResolveDataDirectory(env.ContentRootPath), "probes.json");

public sealed record ProbeResult(DateTime At, bool Ok, double DurationMs, int? Status, string? Error, int? CertificateDays);

/// <summary>État courant d'une sonde (en mémoire, recalculé au démarrage).</summary>
public sealed class ProbeState
{
    /// <summary>up, down ou unknown.</summary>
    public string Status { get; set; } = "unknown";
    public DateTime Since { get; set; } = DateTime.UtcNow;
    public int ConsecutiveFailures { get; set; }
    public ProbeResult? Last { get; set; }
    public List<ProbeResult> Recent { get; set; } = [];
}

/// <summary>Exécute les sondes et enregistre les résultats comme métriques (vigil.probe.up, vigil.probe.duration).</summary>
public sealed class ProbeEngine(ProbeStore probes, Ingestor ingestor, IHttpClientFactory http, ILogger<ProbeEngine> log) : BackgroundService
{
    private readonly ConcurrentDictionary<string, ProbeState> _states = new();
    private readonly ConcurrentDictionary<string, DateTime> _nextRun = new();

    public ProbeState? State(string id) => _states.TryGetValue(id, out var s) ? s : null;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        var running = new ConcurrentDictionary<string, Task>();
        while (await timer.WaitForNextTickAsync(stop))
        {
            var now = DateTime.UtcNow;
            foreach (var p in probes.All())
            {
                if (!p.Enabled || string.IsNullOrWhiteSpace(p.Target) || running.ContainsKey(p.Id)) continue;
                if (_nextRun.TryGetValue(p.Id, out var next) && next > now) continue;
                _nextRun[p.Id] = now.AddSeconds(Math.Max(10, p.IntervalSeconds));
                running[p.Id] = Task.Run(async () =>
                {
                    try { await RunAsync(p, stop); }
                    catch (Exception ex) when (!stop.IsCancellationRequested) { log.LogWarning(ex, "Sonde {Name}", p.Name); }
                    finally { running.TryRemove(p.Id, out _); }
                }, stop);
            }
            foreach (var id in _states.Keys)
                if (probes.Get(id) is null) _states.TryRemove(id, out _);
        }
    }

    /// <summary>Exécution immédiate (bouton « Tester »), sans attendre l'intervalle.</summary>
    public async Task<ProbeResult> RunAsync(Probe p, CancellationToken ct, bool record = true)
    {
        var result = await CheckAsync(p, ct);
        if (!record) return result;

        var state = _states.GetOrAdd(p.Id, _ => new ProbeState());
        lock (state)
        {
            state.Last = result;
            state.Recent.Insert(0, result);
            if (state.Recent.Count > 20) state.Recent.RemoveAt(20);
            state.ConsecutiveFailures = result.Ok ? 0 : state.ConsecutiveFailures + 1;
            var status = result.Ok ? "up" : state.ConsecutiveFailures >= Math.Max(1, p.FailuresBeforeDown) ? "down" : state.Status;
            if (status != state.Status)
            {
                state.Status = status;
                state.Since = result.At;
            }
        }
        await RecordAsync(p, result, ct);
        return result;
    }

    private async Task<ProbeResult> CheckAsync(Probe p, CancellationToken ct)
    {
        var at = DateTime.UtcNow;
        var sw = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(p.TimeoutSeconds, 1, 120)));
        try
        {
            if (p.Type == "tcp")
            {
                var (host, port) = ParseHostPort(p.Target);
                using var client = new TcpClient();
                await client.ConnectAsync(host, port, timeout.Token);
                return new ProbeResult(at, true, sw.Elapsed.TotalMilliseconds, null, null, null);
            }

            var client2 = http.CreateClient(p.IgnoreTlsErrors ? "probe-insecure" : "probe");
            using var request = new HttpRequestMessage(new HttpMethod(string.IsNullOrWhiteSpace(p.Method) ? "GET" : p.Method.ToUpperInvariant()), p.Target);
            request.Headers.UserAgent.ParseAdd("Vigil-Probe/1.0");
            using var response = await client2.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var status = (int)response.StatusCode;
            string? error = null;
            if (!StatusMatches(status, p.ExpectedStatus)) error = $"Code HTTP {status} (attendu : {p.ExpectedStatus})";
            else if (!string.IsNullOrEmpty(p.ExpectedText))
            {
                var body = await response.Content.ReadAsStringAsync(timeout.Token);
                if (!body.Contains(p.ExpectedText, StringComparison.OrdinalIgnoreCase)) error = $"Texte « {p.ExpectedText} » absent de la réponse";
            }
            int? certDays = null;
            if (request.RequestUri is { Scheme: "https" } uri && CertificateExpiries.TryGetValue(uri.IdnHost, out var expiry))
                certDays = (int)Math.Floor((expiry - DateTime.UtcNow).TotalDays);
            if (error is null && certDays is < 0) error = "Certificat TLS expiré";
            return new ProbeResult(at, error is null, sw.Elapsed.TotalMilliseconds, status, error, certDays);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new ProbeResult(at, false, sw.Elapsed.TotalMilliseconds, null, $"Pas de réponse en {p.TimeoutSeconds} s", null);
        }
        catch (Exception ex) when (ex is HttpRequestException or SocketException or IOException or FormatException or InvalidOperationException or UriFormatException)
        {
            var message = ex.InnerException?.Message ?? ex.Message;
            return new ProbeResult(at, false, sw.Elapsed.TotalMilliseconds, null, message, null);
        }
    }

    /// <summary>Expiration du certificat TLS de chaque hôte, relevée à l'établissement de la connexion.</summary>
    private static readonly ConcurrentDictionary<string, DateTime> CertificateExpiries = new(StringComparer.OrdinalIgnoreCase);

    public static SocketsHttpHandler CreateHandler(bool ignoreTlsErrors) => new()
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        AllowAutoRedirect = true,
        SslOptions = new SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = (sender, cert, _, errors) =>
            {
                if (sender is SslStream ssl && cert is not null && !string.IsNullOrEmpty(ssl.TargetHostName))
                    CertificateExpiries[ssl.TargetHostName] = (cert as X509Certificate2 ?? new X509Certificate2(cert)).NotAfter.ToUniversalTime();
                return ignoreTlsErrors || errors == SslPolicyErrors.None;
            },
        },
    };

    private static bool StatusMatches(int status, string? expected)
    {
        if (string.IsNullOrWhiteSpace(expected)) return status is >= 200 and < 400;
        foreach (var part in expected.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var range = part.Split('-', StringSplitOptions.TrimEntries);
            if (range.Length == 2 && int.TryParse(range[0], out var lo) && int.TryParse(range[1], out var hi) && status >= lo && status <= hi) return true;
            if (range.Length == 1 && int.TryParse(range[0], out var one) && status == one) return true;
        }
        return false;
    }

    private static (string Host, int Port) ParseHostPort(string target)
    {
        var t = target.Trim();
        if (t.Contains("://")) t = new Uri(t).Authority;
        var i = t.LastIndexOf(':');
        if (i <= 0 || !int.TryParse(t[(i + 1)..], out var port)) throw new FormatException("Cible TCP attendue sous la forme hôte:port.");
        return (t[..i].Trim('[', ']'), port);
    }

    private async Task RecordAsync(Probe p, ProbeResult r, CancellationToken ct)
    {
        var ts = (ulong)(r.At - DateTime.UnixEpoch).Ticks * 100;
        KeyValue[] attrs = [Kv("probe.id", p.Id), Kv("probe.name", p.Name), Kv("probe.target", p.Target)];
        Metric Gauge(string name, string unit, double value)
        {
            var point = new NumberDataPoint { TimeUnixNano = ts, AsDouble = value };
            point.Attributes.AddRange(attrs);
            return new Metric { Name = name, Unit = unit, Gauge = new Gauge { DataPoints = { point } } };
        }
        var scope = new ScopeMetrics { Scope = new InstrumentationScope { Name = "Vigil.Probes" } };
        scope.Metrics.Add(Gauge("vigil.probe.up", "1", r.Ok ? 1 : 0));
        scope.Metrics.Add(Gauge("vigil.probe.duration", "ms", r.DurationMs));
        if (r.CertificateDays is { } days) scope.Metrics.Add(Gauge("vigil.probe.certificate_days", "d", days));
        var request = new ExportMetricsServiceRequest
        {
            ResourceMetrics =
            {
                new ResourceMetrics
                {
                    Resource = new Resource { Attributes = { Kv("service.name", string.IsNullOrWhiteSpace(p.Service) ? "vigil-sondes" : p.Service) } },
                    ScopeMetrics = { scope },
                },
            },
        };
        await ingestor.IngestMetrics(request, default, ct);
    }

    private static KeyValue Kv(string key, string value) => new() { Key = key, Value = new AnyValue { StringValue = value } };
}
