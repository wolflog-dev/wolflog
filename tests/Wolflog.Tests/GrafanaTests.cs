using System.Net.Http.Headers;

namespace Wolflog.Tests;

/// <summary>Source de données Grafana : clé de lecture, formats large et tableau.</summary>
public class GrafanaTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private async Task<string> ReadKey()
    {
        var ui = await server.LoggedInClient();
        var created = await (await ui.PostAsJsonAsync("/api/admin/keys", new { name = "grafana", kind = "read" })).Content.ReadFromJsonAsync<JsonElement>(Json);
        Assert.Equal("read", created.GetProperty("kind").GetString());
        var key = created.GetProperty("key").GetString()!;
        Assert.StartsWith("wlr_", key);
        return key;
    }

    private HttpClient Reader(string key)
    {
        var client = server.CreateClient();
        client.DefaultRequestHeaders.Add("x-wolflog-key", key);
        return client;
    }

    [Fact]
    public async Task Read_key_reads_grafana_endpoints_but_cannot_ingest_or_use_the_ui_api()
    {
        var key = await ReadKey();
        var reader = Reader(key);

        Assert.Equal(HttpStatusCode.Unauthorized, (await server.CreateClient().GetAsync("/api/grafana")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync("/api/grafana")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.GetAsync("/api/logs")).StatusCode);

        using var content = new ByteArrayContent(Otlp.Trace("intrus", Guid.NewGuid().ToString("N"), DateTime.UtcNow, 1).ToByteArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.PostAsync("/v1/traces", content)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await reader.PostAsync("/v1/rum", new StringContent("{}"))).StatusCode);
    }

    [Fact]
    public async Task Http_series_are_wide_rows_with_one_column_per_statistic()
    {
        var service = "svc-graf-" + Guid.NewGuid().ToString("N")[..6];
        var client = server.CreateClient();
        for (var i = 0; i < 6; i++)
        {
            using var content = new ByteArrayContent(Otlp.Trace(service, Guid.NewGuid().ToString("N"), DateTime.UtcNow.AddSeconds(-30), 1, error: i == 0).ToByteArray());
            content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
            using var message = new HttpRequestMessage(HttpMethod.Post, "/v1/traces") { Content = content };
            message.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
            (await client.SendAsync(message)).EnsureSuccessStatusCode();
        }
        var reader = Reader(await ReadKey());
        var to = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var from = to - 15 * 60_000;

        var rows = await reader.GetFromJsonAsync<JsonElement>($"/api/grafana/http?service={service}&stat=rate,errorRate&from={from}&to={to}", Json);
        var row = rows.EnumerateArray().First(r => r.GetProperty("rate").ValueKind == JsonValueKind.Number && r.GetProperty("rate").GetDouble() > 0);
        Assert.True(row.TryGetProperty("time", out _));
        Assert.True(row.TryGetProperty("errorRate", out _));

        var table = await reader.GetFromJsonAsync<JsonElement>($"/api/grafana/query?source=spans&groupBy=service&format=table&from={from}&to={to}", Json);
        Assert.Contains(table.EnumerateArray(), r => r.GetProperty("service").GetString() == service && r.GetProperty("count").GetInt64() == 6);
    }
}
