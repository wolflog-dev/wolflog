using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;

namespace Wolflog.Tests;

public class StorageTests
{
    private static readonly DateTime From = DateTime.UtcNow.AddHours(-1);
    private static DateTime To => DateTime.UtcNow.AddMinutes(5);

    private static async Task Ingest(StorageHost storage, OpenTelemetry.Proto.Collector.Logs.V1.ExportLogsServiceRequest request)
    {
        var rows = OtlpConverter.ConvertLogs(request);
        await storage.Logs.IngestAsync(rows, request.ToByteArray());
    }

    [Fact]
    public async Task Data_is_queryable_before_and_after_flush()
    {
        using var dir = new TempDir();
        await using var storage = Otlp.CreateStorage(dir.Path);
        var qs = new QueryService(storage);

        await Ingest(storage, Otlp.Logs("api", 1000));
        var hot = qs.SearchLogs(From, To, new SearchQuery(), 5000, null, default);
        Assert.Equal(1000, hot.Items.Count);

        await storage.Logs.FlushAsync();
        Assert.Single(storage.Logs.Snapshot.Segments);
        Assert.DoesNotContain(Directory.GetFiles(Path.Combine(dir.Path, "wal", "logs"), "*.log"), f => new FileInfo(f).Length > 0);

        var cold = qs.SearchLogs(From, To, new SearchQuery(), 5000, null, default);
        Assert.Equal(1000, cold.Items.Count);
        Assert.Equal(cold.Items[0].Ts, cold.Items.Max(i => i.Ts)); // tri décroissant

        var errors = qs.SearchLogs(From, To, SearchQuery.Parse("level:error"), 5000, null, default);
        Assert.Equal(100, errors.Items.Count);
        Assert.All(errors.Items, i => Assert.Equal("error", i.Level));

        var text = qs.SearchLogs(From, To, SearchQuery.Parse("commande-3 http.route:/stock/*"), 5000, null, default);
        Assert.NotEmpty(text.Items);
        Assert.All(text.Items, i => Assert.Contains("commande-3", i.Body));
        Assert.All(text.Items, i => Assert.Contains("/stock/", i.Attributes));

        var none = qs.SearchLogs(From, To, SearchQuery.Parse("introuvable"), 100, null, default);
        Assert.Empty(none.Items);
        Assert.Equal(0, none.ScannedSegments); // élagué par l'index trigrammes
    }

    [Fact]
    public async Task Pagination_with_before_cursor_returns_every_row_once()
    {
        using var dir = new TempDir();
        await using var storage = Otlp.CreateStorage(dir.Path);
        var qs = new QueryService(storage);
        await Ingest(storage, Otlp.Logs("api", 950));
        await storage.Logs.FlushAsync();
        await Ingest(storage, Otlp.Logs("api", 50, DateTime.UtcNow.AddSeconds(1)));

        var seen = new HashSet<DateTime>();
        DateTime? before = null;
        var pages = 0;
        do
        {
            var page = qs.SearchLogs(From, To, new SearchQuery(), 300, before, default);
            foreach (var i in page.Items) seen.Add(i.Ts);
            before = page.NextBefore;
            pages++;
        } while (before != null && pages < 20);
        Assert.Equal(1000, seen.Count);
    }

    [Fact]
    public async Task Wal_recovers_data_after_a_crash()
    {
        using var dir = new TempDir();
        var storage = Otlp.CreateStorage(dir.Path);
        await Ingest(storage, Otlp.Logs("api", 321));
        // Crash simulé : pas de flush, pas de Dispose → seules les données du WAL existent.
        Assert.Empty(storage.Logs.Snapshot.Segments);
        var walDir = Path.Combine(dir.Path, "wal", "logs");
        var copy = Path.Combine(dir.Path, "wal-copy");
        Directory.CreateDirectory(copy);
        foreach (var f in Directory.GetFiles(walDir))
        {
            // Le WAL est ouvert en écriture : copie en partage lecture/écriture.
            using var src = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var dst = File.Create(Path.Combine(copy, Path.GetFileName(f)));
            src.CopyTo(dst);
        }
        await storage.DisposeAsync();

        // Nouveau dossier ne contenant que le WAL (comme après un arrêt brutal).
        using var dir2 = new TempDir();
        Directory.CreateDirectory(Path.Combine(dir2.Path, "wal", "logs"));
        foreach (var f in Directory.GetFiles(copy)) File.Copy(f, Path.Combine(dir2.Path, "wal", "logs", Path.GetFileName(f)));

        await using var recovered = Otlp.CreateStorage(dir2.Path);
        var qs = new QueryService(recovered);
        Assert.Equal(321, qs.SearchLogs(From, To, new SearchQuery(), 5000, null, default).Items.Count);
        Assert.Single(recovered.Logs.Snapshot.Segments);
    }

    [Fact]
    public async Task Restart_reloads_segments_and_compaction_keeps_every_row()
    {
        using var dir = new TempDir();
        await using (var storage = Otlp.CreateStorage(dir.Path))
        {
            for (var i = 0; i < 4; i++)
            {
                await Ingest(storage, Otlp.Logs("svc-" + i, 250, DateTime.UtcNow.AddSeconds(i)));
                await storage.Logs.FlushAsync();
            }
            Assert.Equal(4, storage.Logs.Snapshot.Segments.Length);
        }

        await using var reopened = Otlp.CreateStorage(dir.Path);
        Assert.Equal(4, reopened.Logs.Snapshot.Segments.Length);
        await reopened.Logs.CompactAsync(force: true);
        Assert.Single(reopened.Logs.Snapshot.Segments);
        var qs = new QueryService(reopened);
        Assert.Equal(1000, qs.SearchLogs(From, To, new SearchQuery(), 5000, null, default).Items.Count);
        Assert.Equal(250, qs.SearchLogs(From, To, SearchQuery.Parse("service:svc-2"), 5000, null, default).Items.Count);
        var services = qs.Services(From, To, default);
        Assert.Equal(4, services.Count);
    }

    [Fact]
    public async Task Retention_removes_expired_segments()
    {
        using var dir = new TempDir();
        await using var storage = Otlp.CreateStorage(dir.Path, o => o.Retention.LogsDays = 1);
        await Ingest(storage, Otlp.Logs("old", 10, DateTime.UtcNow.AddDays(-3)));
        await storage.Logs.FlushAsync();
        await Ingest(storage, Otlp.Logs("new", 10));
        await storage.Logs.FlushAsync();
        storage.ApplyRetention();
        Assert.Single(storage.Logs.Snapshot.Segments);
        Assert.Contains("new", storage.Logs.Snapshot.Segments[0].Index.Services);
    }

    [Fact]
    public async Task Errors_are_grouped_by_fingerprint()
    {
        using var dir = new TempDir();
        await using var storage = Otlp.CreateStorage(dir.Path);
        var request = Otlp.Logs("api", 30, make: i => new LogRecord
        {
            SeverityNumber = SeverityNumber.Error,
            Body = new AnyValue { StringValue = "Erreur" },
            Attributes =
            {
                Otlp.Kv("exception.type", i % 3 == 0 ? "System.TimeoutException" : "System.InvalidOperationException"),
                Otlp.Kv("exception.message", $"Échec {i}"),
                Otlp.Kv("exception.stacktrace", $"System.X: Échec\n   at App.Service.Run() in C:\\a.cs:line {i}"),
            },
        });
        await Ingest(storage, request);
        await storage.Logs.FlushAsync();
        var qs = new QueryService(storage);
        var groups = qs.Errors(From, To, new SearchQuery(), 100, default);
        Assert.Equal(2, groups.Count);
        Assert.Equal(30, groups.Sum(g => g.Count));
        var detail = qs.ErrorDetail(groups[0].Fingerprint, From, To, default);
        Assert.NotNull(detail?.Latest?.ExceptionStack);
        Assert.Equal(groups[0].Count, detail!.Occurrences.Count);
    }

    [Fact]
    public async Task Traces_are_listed_and_detailed_with_their_logs()
    {
        using var dir = new TempDir();
        await using var storage = Otlp.CreateStorage(dir.Path);
        var traceId = "0af7651916cd43dd8448eb211c80319c";
        var trace = Otlp.Trace("api", traceId, DateTime.UtcNow, 5, error: true);
        await storage.Spans.IngestAsync(OtlpConverter.ConvertSpans(trace), trace.ToByteArray());
        await storage.Spans.IngestAsync(OtlpConverter.ConvertSpans(Otlp.Trace("api", "1af7651916cd43dd8448eb211c80319c", DateTime.UtcNow, 2)), default);
        var logs = Otlp.Logs("api", 3, make: i => new LogRecord
        {
            SeverityNumber = SeverityNumber.Info,
            Body = new AnyValue { StringValue = "dans la trace" },
            TraceId = ByteString.CopyFrom(Convert.FromHexString(traceId)),
        });
        await Ingest(storage, logs);
        await storage.Spans.FlushAsync();

        var qs = new QueryService(storage);
        var list = qs.SearchTraces(From, To, null, null, null, false, 50, default);
        Assert.Equal(2, list.Count);
        var t = Assert.Single(qs.SearchTraces(From, To, "api", null, null, true, 50, default));
        Assert.Equal(traceId, t.TraceId);
        Assert.Equal("GET /orders/{id}", t.RootName);
        Assert.Equal(5, t.Spans);
        Assert.Equal(1, t.Errors);

        var detail = qs.GetTrace(traceId, DateTime.UtcNow, default);
        Assert.Equal(5, detail.Spans.Count);
        Assert.Equal(3, detail.Logs.Count);
        Assert.Null(detail.Spans[0].ParentSpanId);
    }
}
