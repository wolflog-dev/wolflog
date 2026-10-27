using System.IO.Compression;
using System.Net.Http.Headers;
using DuckDB.NET.Data;
using Wolflog.Server.Hosting;
using Wolflog.Server.Monitoring;

namespace Wolflog.Tests;

/// <summary>
/// Protections ajoutées après les défauts d'octobre 2026 (Brotli « Node2Shell » CVE-2026-111497) : bombes de
/// décompression, brotli refusé à la réception, DuckDB limité au dossier des données, segments restaurés contrôlés.
/// </summary>
public class SecurityHardeningTests(WolflogServerFixture server) : IClassFixture<WolflogServerFixture>
{
    private static HttpRequestMessage Otlp(byte[] body, string? encoding)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/logs") { Content = new ByteArrayContent(body) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/x-protobuf");
        if (encoding != null) request.Content.Headers.ContentEncoding.Add(encoding);
        request.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
        return request;
    }

    private static byte[] Gzip(byte[] data)
    {
        using var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, CompressionLevel.Optimal, leaveOpen: true)) gz.Write(data);
        return ms.ToArray();
    }

    [Fact]
    public async Task Gzip_bomb_is_refused_without_reading_it_entirely()
    {
        // 200 Mo de zéros : moins de 1 Mo compressés, au-delà du plafond de 128 Mo une fois décompressés.
        var bomb = Gzip(new byte[200 * 1024 * 1024]);
        Assert.True(bomb.Length < 1024 * 1024);
        var response = await server.CreateClient().SendAsync(Otlp(bomb, "gzip"));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    [Fact]
    public async Task Gzip_within_the_limit_is_still_accepted()
    {
        var response = await server.CreateClient().SendAsync(Otlp(Gzip(Tests.Otlp.Logs("gzip-ok", 3).ToByteArray()), "gzip"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Brotli_is_never_decoded()
    {
        using var ms = new MemoryStream();
        using (var br = new BrotliStream(ms, CompressionLevel.Fastest, leaveOpen: true)) br.Write(Tests.Otlp.Logs("br", 1).ToByteArray());
        var response = await server.CreateClient().SendAsync(Otlp(ms.ToArray(), "br"));
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
    }

    [Fact]
    public async Task Profile_upload_is_capped_too()
    {
        // JSON valide qui grossit (une chaîne de 200 Mo) : la lecture s'arrête au plafond, pas sur une erreur de syntaxe.
        var json = new byte[200 * 1024 * 1024];
        Array.Fill(json, (byte)'a');
        "{\"id\":\""u8.CopyTo(json);
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/profiles") { Content = new ByteArrayContent(Gzip(json)) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Content.Headers.ContentEncoding.Add("gzip");
        request.Headers.Add("x-wolflog-key", WolflogServerFixture.ApiKey);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await server.CreateClient().SendAsync(request)).StatusCode);
    }

    [Fact]
    public void Size_limited_stream_allows_exactly_the_limit()
    {
        using var exact = new SizeLimitedStream(new MemoryStream(new byte[1000]), 1000);
        exact.CopyTo(Stream.Null);
        using var over = new SizeLimitedStream(new MemoryStream(new byte[1001]), 1000);
        Assert.Throws<PayloadTooLargeException>(() => over.CopyTo(Stream.Null));
    }

    [Fact]
    public void DuckDb_reads_and_writes_only_in_the_data_directory()
    {
        using var data = new TempDir();
        using var outside = new TempDir();
        var secret = Path.Combine(outside.Path, "secret.csv");
        File.WriteAllText(secret, "a,b\n1,2\n");
        using var engine = new DuckDbEngine(data.Path, "256MB", 0);

        // Fonctionnement normal : segments écrits puis relus dans le dossier des données.
        var segment = Path.Combine(data.Path, "seg.parquet");
        engine.Execute($"COPY (SELECT 42 AS x) TO {Sql.Path(segment)} (FORMAT PARQUET, COMPRESSION ZSTD)");
        Assert.Equal(1L, Scalar(engine, $"SELECT count(*) FROM read_parquet([{Sql.Path(segment)}])"));

        // Ce qu'une injection SQL tenterait : lire ou écrire ailleurs, réactiver l'accès, charger une extension.
        Assert.ThrowsAny<Exception>(() => Scalar(engine, $"SELECT count(*) FROM read_csv({Sql.Path(secret)})"));
        Assert.ThrowsAny<Exception>(() => engine.Execute($"COPY (SELECT 1) TO {Sql.Path(Path.Combine(outside.Path, "x.csv"))}"));
        Assert.ThrowsAny<Exception>(() => engine.Execute("SET enable_external_access = true"));
        Assert.ThrowsAny<Exception>(() => engine.Execute($"SET allowed_directories = [{Sql.Path(outside.Path)}]"));
        Assert.ThrowsAny<Exception>(() => engine.Execute("LOAD httpfs"));
    }

    [Fact]
    public void Restored_segments_compressed_with_brotli_are_set_aside()
    {
        using var source = new TempDir();
        var good = Path.Combine("logs", "2026-10-27", "10", "seg-000000000001.parquet");
        var bad = Path.Combine("logs", "2026-10-27", "10", "seg-000000000002.parquet");
        WriteParquet(Path.Combine(source.Path, good), "ZSTD");
        WriteParquet(Path.Combine(source.Path, bad), "BROTLI");
        Assert.Null(ParquetGuard.Problem(Path.Combine(source.Path, good)));
        Assert.Contains("BROTLI", ParquetGuard.Problem(Path.Combine(source.Path, bad)));

        using var archive = new MemoryStream();
        Backup.Write(source.Path, archive, includeData: true);
        archive.Position = 0;
        using var target = new TempDir();
        var result = Backup.Restore(target.Path, archive, includeData: true);
        Assert.Equal(1, result.DataFiles);
        Assert.Single(result.Rejected);
        Assert.True(File.Exists(Path.Combine(target.Path, good)));
        Assert.False(File.Exists(Path.Combine(target.Path, bad)));
    }

    [Fact]
    public void Health_report_flags_a_runtime_without_the_october_fixes()
    {
        Assert.Equal("warning", HealthService.RuntimeCheck(new Version(10, 0, 12)).Status);
        Assert.Equal("ok", HealthService.RuntimeCheck(new Version(10, 0, 14)).Status);
        Assert.Equal("ok", HealthService.RuntimeCheck(new Version(11, 0, 0)).Status);
    }

    /// <summary>Segment Parquet réel avec le codec demandé (écriture : aucun décodage brotli).</summary>
    public static void WriteParquet(string file, string codec)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        using var connection = new DuckDBConnection("DataSource=:memory:");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"COPY (SELECT range AS x, 'texte ' || range AS y FROM range(100)) TO {Sql.Path(file)} (FORMAT PARQUET, COMPRESSION {codec})";
        cmd.ExecuteNonQuery();
    }

    private static object? Scalar(DuckDbEngine engine, string sql)
    {
        using var connection = engine.Connect();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }
}
