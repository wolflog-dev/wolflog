using OpenTelemetry.Proto.Common.V1;
using OpenTelemetry.Proto.Logs.V1;

namespace Wolflog.Tests;

public class CustomQueryTests
{
    private static readonly DateTime From = DateTime.UtcNow.AddHours(-1);
    private static DateTime To => DateTime.UtcNow.AddMinutes(5);

    private static async Task<(TempDir Dir, Wolflog.Server.Storage.StorageHost Storage)> Seed()
    {
        var dir = new TempDir();
        var storage = Otlp.CreateStorage(dir.Path);
        var logs = Otlp.Logs("shop", 100, make: i => new LogRecord
        {
            SeverityNumber = i % 5 == 0 ? SeverityNumber.Warn : SeverityNumber.Info,
            Body = new AnyValue { StringValue = $"Panier {i}" },
            Attributes =
            {
                Otlp.Kv("http.route", i % 2 == 0 ? "/cart" : "/pay"),
                new KeyValue { Key = "cart.items", Value = new AnyValue { IntValue = i % 10 } },
                Otlp.Kv("{OriginalFormat}", "Panier {Id}"),
            },
        });
        await storage.Logs.IngestAsync(OtlpConverter.ConvertLogs(logs), logs.ToByteArray());
        var trace = Otlp.Trace("shop", "0af7651916cd43dd8448eb211c80319c", DateTime.UtcNow, 4);
        await storage.Spans.IngestAsync(OtlpConverter.ConvertSpans(trace), trace.ToByteArray());
        await storage.Logs.FlushAsync();
        return (dir, storage);
    }

    [Fact]
    public async Task Top_count_by_builtin_and_attribute_fields()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var qs = new QueryService(storage);

        var byLevel = qs.Custom(new CustomQuery("logs", null, "count", null, "level", "top", 10, null), From, To, default);
        Assert.Equal(80, byLevel.Rows!.Single(r => r.Group == "info").Value);
        Assert.Equal(20, byLevel.Rows!.Single(r => r.Group == "warn").Value);

        var byRoute = qs.Custom(new CustomQuery("logs", "level:warn", "count", null, "http.route", "table", 10, null), From, To, default);
        Assert.Equal(20, byRoute.Rows!.Sum(r => r.Value));

        var avgItems = qs.Custom(new CustomQuery("logs", "http.route:/cart", "avg", "cart.items", null, "stat", 10, null), From, To, default);
        Assert.Equal(4, avgItems.Value!.Value, 3); // éléments pairs de 0 à 8 → moyenne 4

        var templates = qs.Custom(new CustomQuery("logs", null, "count", null, "template", "top", 5, null), From, To, default);
        Assert.Equal("Panier {Id}", Assert.Single(templates.Rows!).Group);
    }

    [Fact]
    public async Task Timeseries_and_span_durations()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var qs = new QueryService(storage);

        var series = qs.Custom(new CustomQuery("logs", null, "count", null, "http.route", "timeseries", 10, null), From, To, default);
        Assert.Equal(2, series.Series!.Count);
        Assert.Equal(100, series.Series!.Sum(s => s.Values.Sum(v => v ?? 0)));

        var slowest = qs.Custom(new CustomQuery("spans", "kind:serveur", "p95", "duration", "name", "top", 10, null), From, To, default);
        var root = Assert.Single(slowest.Rows!);
        Assert.Equal("GET /orders/{id}", root.Group);
        Assert.Equal("ms", slowest.Unit);

        Assert.Throws<ArgumentException>(() => qs.Custom(new CustomQuery("spans", null, "p95", null, null, "stat", 10, null), From, To, default));
    }

    [Fact]
    public async Task Fields_are_discovered_from_the_data()
    {
        var (dir, storage) = await Seed();
        using var _ = dir;
        await using var __ = storage;
        var qs = new QueryService(storage);

        var fields = qs.Fields("logs", From, To, default);
        Assert.Contains(fields, f => f is { Key: "level", Builtin: true });
        Assert.Contains(fields, f => f is { Key: "http.route", Kind: "text", Builtin: false });
        Assert.Contains(fields, f => f is { Key: "cart.items", Kind: "number" });
        Assert.DoesNotContain(fields, f => f.Key == "{OriginalFormat}");

        var values = qs.FieldValues("logs", "http.route", From, To, default);
        Assert.Equal(["/cart", "/pay"], values.Select(v => v.Value).Order());
        Assert.Contains(qs.Fields("spans", From, To, default), f => f is { Key: "duration", Kind: "number" });
    }
}
