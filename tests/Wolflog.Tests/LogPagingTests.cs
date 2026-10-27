using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;

namespace Wolflog.Tests;

/// <summary>Pagination des logs dans les deux sens (même microseconde comprise), exclusions et listes de la recherche.</summary>
public class LogPagingTests
{
    private static readonly DateTime From = DateTime.UtcNow.AddHours(-1);
    private static readonly DateTime To = DateTime.UtcNow.AddHours(1);

    private static async Task<StorageHost> Store(TempDir dir, int count, Func<int, LogRecord> make)
    {
        var storage = Otlp.CreateStorage(dir.Path);
        var request = Otlp.Logs("boutique", count, make: make);
        await storage.Logs.IngestAsync(OtlpConverter.ConvertLogs(request), request.ToByteArray());
        await storage.Logs.FlushAsync();
        return storage;
    }

    [Fact]
    public async Task Pages_through_logs_of_the_same_microsecond_in_both_directions()
    {
        using var dir = new TempDir();
        var t = Otlp.Nanos(DateTime.UtcNow.AddMinutes(-5));
        // 30 logs à la même microseconde, 10 autres ensuite.
        await using var storage = await Store(dir, 40, i => new LogRecord
        {
            TimeUnixNano = i < 30 ? t : t + (ulong)i * 1_000_000,
            SeverityNumber = SeverityNumber.Info,
            Body = new AnyValue { StringValue = $"commande {i}" },
        });
        var qs = new QueryService(storage);
        var q = SearchQuery.Parse("");

        var seen = new List<LogItem>();
        DateTime? before = null;
        string? key = null;
        while (true)
        {
            var page = qs.SearchLogs(From, To, q, 7, before, default, key);
            seen.AddRange(page.Items);
            if (page.Items.Count < 7) break;
            (before, key) = (page.Items[^1].Ts, page.Items[^1].Key);
        }
        Assert.Equal(40, seen.Count);
        Assert.Equal(40, seen.Select(l => l.Body).Distinct().Count());

        // Dans l'autre sens : les plus récents que le 25e, dans l'ordre de la liste (au milieu des 30 identiques).
        var newer = qs.SearchLogs(From, To, q, 100, null, default, after: seen[24].Ts, afterKey: seen[24].Key);
        Assert.Equal(seen.Take(24).Select(l => l.Body), newer.Items.Select(l => l.Body));
    }

    [Fact]
    public async Task Excludes_fields_and_accepts_lists_in_sql_and_live()
    {
        using var dir = new TempDir();
        await using var storage = await Store(dir, 6, i => new LogRecord
        {
            SeverityNumber = SeverityNumber.Info,
            Body = new AnyValue { StringValue = $"requête {i}" },
            Attributes = { Otlp.Kv("http.route", i % 3 == 0 ? "/health" : i % 3 == 1 ? "/api/orders" : "/api/cart") },
        });
        var qs = new QueryService(storage);
        int Count(string search) => qs.SearchLogs(From, To, SearchQuery.Parse(search), 100, null, default).Items.Count;

        Assert.Equal(4, Count("-http.route:/health"));
        Assert.Equal(4, Count("http.route:/api/orders,/api/cart"));
        Assert.Equal(2, Count("http.route:/api/* -http.route:/api/cart"));
        Assert.Equal(0, Count("-service:boutique"));
        Assert.Equal(6, Count("service:boutique,autre"));

        var row = new LogRow { Service = "api", Severity = 9, Body = "ok", Host = "web-3", Attributes = """{"http.route":"/health"}""" };
        Assert.False(SearchQuery.Parse("-host:web-3").Matches(row));
        Assert.True(SearchQuery.Parse("-host:web-1 host:web-2,web-3").Matches(row));
        Assert.False(SearchQuery.Parse("-http.route:/health").Matches(row));
        Assert.False(SearchQuery.Parse("-service:api").Matches(row));
    }
}
