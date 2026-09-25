using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Threading.Channels;
using DuckDB.NET.Data;

namespace Vigil.Server.Storage;

public sealed record Segment(string Path, string Partition, SegmentIndex Index, long SizeBytes);

/// <summary>Vue cohérente et immuable du stockage à un instant donné (segments sur disque + tables en mémoire).</summary>
public sealed record StoreSnapshot(ImmutableArray<Segment> Segments, ImmutableArray<string> HotTables);

public interface ISignalStore
{
    string Name { get; }
    StoreSnapshot Snapshot { get; }
    long IngestedRows { get; }
    long HotRows { get; }
    /// <summary>Lots reçus en attente d'écriture (file saturée = disque trop lent).</summary>
    int Backlog { get; }
    DateTime? LastIngestAt { get; }
    DateTime? LastErrorAt { get; }
    string? LastError { get; }
    Task FlushAsync();
    void RemoveSegments(IReadOnlyCollection<Segment> segments);
    Task CompactAsync(bool force = false);
    void ApplyRetention(DateTime cutoff);
}

/// <summary>
/// Pipeline de stockage d'un type de signal :
/// réception → WAL → table DuckDB en mémoire (interrogeable immédiatement) → segment Parquet compressé.
/// Un seul thread écrit (pas de verrou sur le chemin critique) ; les lectures travaillent sur des snapshots immuables.
/// </summary>
public sealed class SignalStore<TRow> : ISignalStore, IAsyncDisposable
{
    private sealed class WorkItem
    {
        public List<TRow>? Rows;
        public ReadOnlyMemory<byte> Payload;
        public TaskCompletionSource? Done;
        public bool Flush;
    }

    private readonly SignalSchema<TRow> _schema;
    private readonly DuckDbEngine _engine;
    private readonly string _segmentsDir;
    private readonly Wal _wal;
    private readonly VigilServerOptions.StorageOptions _options;
    private readonly ILogger _log;
    private readonly Channel<WorkItem> _channel;
    private readonly Lock _snapLock = new();
    private readonly ConcurrentQueue<(DateTime Due, string What, Action Action)> _deferred = new();
    private readonly CancellationTokenSource _stop = new();

    private DuckDBConnection? _writer;
    private string _hotTable = "";
    private SegmentIndex _hotIndex = new();
    private long _hotRows;
    private long _ingested;
    private DateTime _lastFlush = DateTime.UtcNow;
    private volatile StoreSnapshot _snapshot = new([], []);
    private Task? _writerTask, _timerTask;

    /// <summary>Appelé (sur le thread d'écriture) pour chaque lot stocké : sert au "live tail".</summary>
    public Action<IReadOnlyList<TRow>>? RowsStored { get; set; }

    public SignalStore(SignalSchema<TRow> schema, DuckDbEngine engine, string dataDirectory, VigilServerOptions.StorageOptions options, ILogger log)
    {
        _schema = schema;
        _engine = engine;
        _options = options;
        _log = log;
        _segmentsDir = Path.Combine(dataDirectory, schema.Name);
        _wal = new Wal(Path.Combine(dataDirectory, "wal", schema.Name), options.FsyncWal);
        _channel = Channel.CreateBounded<WorkItem>(new BoundedChannelOptions(4096)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.Wait,
        });
    }

    public string Name => _schema.Name;
    public SignalSchema<TRow> Schema => _schema;
    public StoreSnapshot Snapshot => _snapshot;
    public long IngestedRows => Interlocked.Read(ref _ingested);
    public long HotRows => Interlocked.Read(ref _hotRows);
    public int Backlog => _channel.Reader.Count;
    public DateTime? LastIngestAt { get; private set; }
    public DateTime? LastErrorAt { get; private set; }
    public string? LastError { get; private set; }

    // ------------------------------------------------------------------ démarrage

    public void Start()
    {
        Directory.CreateDirectory(_segmentsDir);
        _writer = _engine.Connect();
        Exec($"CREATE TABLE IF NOT EXISTS {_schema.Name}_empty ({_schema.Columns})");
        LoadSegments();

        var walFiles = _wal.ExistingFiles();
        var maxGen = walFiles.Count > 0 ? walFiles.Max(Wal.GenerationOf) : 0;
        var generation = Math.Max(maxGen, MaxSegmentGeneration()) + 1;
        OpenHotTable(generation);

        if (walFiles.Count > 0) Recover(walFiles);

        _writerTask = Task.Factory.StartNew(WriterLoop, TaskCreationOptions.LongRunning).Unwrap();
        _timerTask = TimerLoop();
    }

    private void Recover(IReadOnlyList<string> walFiles)
    {
        var sw = Stopwatch.StartNew();
        long rows = 0;
        foreach (var file in walFiles)
        {
            foreach (var payload in Wal.Read(file))
            {
                try
                {
                    var batch = _schema.Decode(payload);
                    AppendRows(batch);
                    rows += batch.Count;
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Enregistrement WAL illisible ignoré dans {File}", file);
                }
            }
        }
        _log.LogInformation("{Signal}: {Rows} lignes récupérées depuis le WAL en {Ms} ms", Name, rows, sw.ElapsedMilliseconds);
        FlushCore();
        foreach (var f in walFiles)
        {
            try { File.Delete(f); } catch (IOException ex) { _log.LogWarning(ex, "Impossible de supprimer {File}", f); }
        }
    }

    private void LoadSegments()
    {
        foreach (var tmp in Directory.EnumerateFiles(_segmentsDir, "*.tmp", SearchOption.AllDirectories))
            TryDelete(tmp);

        var segments = ImmutableArray.CreateBuilder<Segment>();
        foreach (var file in Directory.EnumerateFiles(_segmentsDir, "*.parquet", SearchOption.AllDirectories))
        {
            try
            {
                var idxPath = file + ".idx";
                SegmentIndex index;
                if (File.Exists(idxPath))
                {
                    index = JsonSerializer.Deserialize<SegmentIndex>(File.ReadAllBytes(idxPath))!;
                }
                else
                {
                    index = RebuildIndex(file);
                    File.WriteAllBytes(idxPath, JsonSerializer.SerializeToUtf8Bytes(index));
                }
                segments.Add(new Segment(file, Path.GetDirectoryName(file)!, index, new FileInfo(file).Length));
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Segment illisible ignoré : {File}", file);
            }
        }
        _snapshot = new StoreSnapshot(segments.ToImmutable(), []);
        _log.LogInformation("{Signal}: {Count} segments chargés", Name, segments.Count);
    }

    private SegmentIndex RebuildIndex(string file)
    {
        using var cmd = _writer!.CreateCommand();
        cmd.CommandText = $"SELECT min(ts), max(ts), count(*), string_agg(DISTINCT service, chr(1)) FROM read_parquet({Sql.Path(file)})";
        using var r = cmd.ExecuteReader();
        r.Read();
        return SegmentIndex.Unknown(
            r.IsDBNull(0) ? DateTime.MinValue : r.GetDateTime(0),
            r.IsDBNull(1) ? DateTime.MaxValue : r.GetDateTime(1),
            r.GetInt64(2),
            r.IsDBNull(3) ? [] : r.GetString(3).Split('\u0001'));
    }

    private long MaxSegmentGeneration()
    {
        long max = 0;
        foreach (var s in _snapshot.Segments)
        {
            var name = Path.GetFileNameWithoutExtension(s.Path);
            if (name.StartsWith("seg-", StringComparison.Ordinal) &&
                long.TryParse(name.AsSpan(4), NumberStyles.None, CultureInfo.InvariantCulture, out var g) && g > max)
                max = g;
        }
        return max;
    }

    // ------------------------------------------------------------------ ingestion

    /// <summary>Stocke un lot. La tâche se termine quand le lot est dans le WAL et interrogeable.</summary>
    public async ValueTask IngestAsync(List<TRow> rows, ReadOnlyMemory<byte> payload, CancellationToken ct = default)
    {
        if (rows.Count == 0) return;
        var item = new WorkItem { Rows = rows, Payload = payload, Done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously) };
        await _channel.Writer.WriteAsync(item, ct).ConfigureAwait(false);
        await item.Done.Task.WaitAsync(ct).ConfigureAwait(false);
    }

    public async Task FlushAsync()
    {
        var item = new WorkItem { Flush = true, Done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously) };
        await _channel.Writer.WriteAsync(item).ConfigureAwait(false);
        await item.Done.Task.ConfigureAwait(false);
    }

    private async Task WriterLoop()
    {
        var batch = new List<WorkItem>(256);
        var reader = _channel.Reader;
        while (await reader.WaitToReadAsync().ConfigureAwait(false))
        {
            batch.Clear();
            while (batch.Count < 256 && reader.TryRead(out var item)) batch.Add(item);

            var flushRequested = false;
            try
            {
                // 1. Durabilité : tout le lot dans le WAL, un seul flush disque.
                var hasData = false;
                foreach (var item in batch)
                {
                    if (item.Flush) { flushRequested = true; continue; }
                    if (!item.Payload.IsEmpty) _wal.Append(item.Payload.Span);
                    hasData = true;
                }
                if (hasData) _wal.Commit();

                // 2. Table en mémoire (visible par les requêtes).
                foreach (var item in batch)
                {
                    if (item.Rows is null) continue;
                    AppendRows(item.Rows);
                    Interlocked.Add(ref _ingested, item.Rows.Count);
                    LastIngestAt = DateTime.UtcNow;
                    try { RowsStored?.Invoke(item.Rows); } catch (Exception ex) { _log.LogDebug(ex, "Live tail"); }
                }

                foreach (var item in batch)
                    if (!item.Flush) item.Done?.TrySetResult();

                // 3. Passage en Parquet.
                if (flushRequested || _hotRows >= _options.FlushRows ||
                    (_hotRows > 0 && DateTime.UtcNow - _lastFlush >= TimeSpan.FromSeconds(_options.FlushIntervalSeconds)))
                {
                    FlushCore();
                }

                foreach (var item in batch)
                    if (item.Flush) item.Done?.TrySetResult();
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "{Signal}: erreur d'écriture", Name);
                LastError = ex.Message;
                LastErrorAt = DateTime.UtcNow;
                foreach (var item in batch) item.Done?.TrySetException(ex);
            }
        }
        // Arrêt : on vide la mémoire sur disque.
        try { FlushCore(); } catch (Exception ex) { _log.LogError(ex, "{Signal}: flush final impossible", Name); }
    }

    private async Task TimerLoop()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Clamp(_options.FlushIntervalSeconds / 4, 1, 15)));
        var nextCompaction = DateTime.UtcNow.AddMinutes(1);
        try
        {
            while (await timer.WaitForNextTickAsync(_stop.Token).ConfigureAwait(false))
            {
                if (_hotRows > 0 && DateTime.UtcNow - _lastFlush >= TimeSpan.FromSeconds(_options.FlushIntervalSeconds))
                    _channel.Writer.TryWrite(new WorkItem { Flush = true });

                RunDeferred(force: false);

                if (DateTime.UtcNow >= nextCompaction)
                {
                    nextCompaction = DateTime.UtcNow.AddMinutes(5);
                    try { await CompactAsync().ConfigureAwait(false); }
                    catch (Exception ex) { _log.LogError(ex, "{Signal}: compaction en échec", Name); }
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private void AppendRows(List<TRow> rows)
    {
        using (var appender = _writer!.CreateAppender(_hotTable))
        {
            foreach (var r in rows) _schema.Append(appender.CreateRow(), r);
        }
        foreach (var r in rows) _schema.Index(_hotIndex, r);
        Interlocked.Add(ref _hotRows, rows.Count);
    }

    private void OpenHotTable(long generation)
    {
        _hotTable = $"{_schema.Name}_hot_{generation}";
        Exec($"CREATE TABLE {_hotTable} ({_schema.Columns})");
        _hotIndex = new SegmentIndex();
        Interlocked.Exchange(ref _hotRows, 0);
        _wal.Open(generation);
        lock (_snapLock)
        {
            _snapshot = _snapshot with { HotTables = _snapshot.HotTables.Add(_hotTable) };
        }
    }

    /// <summary>Écrit la table chaude courante dans un segment Parquet (thread d'écriture uniquement).</summary>
    private void FlushCore()
    {
        _lastFlush = DateTime.UtcNow;
        if (_hotRows == 0) return;

        var sw = Stopwatch.StartNew();
        var table = _hotTable;
        var index = _hotIndex;
        var rows = _hotRows;
        var generation = _wal.Generation;

        // Les nouvelles lignes vont dans une nouvelle table pendant l'écriture du segment.
        OpenHotTable(generation + 1);

        var now = DateTime.UtcNow;
        var dir = Path.Combine(_segmentsDir, now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), now.ToString("HH", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, $"seg-{generation:D12}.parquet");

        try
        {
            WriteParquet($"SELECT * FROM {table} ORDER BY ts", file, index);
        }
        catch
        {
            // La table reste interrogeable et le WAL est conservé : rien n'est perdu, nouvel essai au redémarrage.
            throw;
        }

        var segment = new Segment(file, dir, index, new FileInfo(file).Length);
        lock (_snapLock)
        {
            _snapshot = new StoreSnapshot(_snapshot.Segments.Add(segment), _snapshot.HotTables.Remove(table));
        }
        _wal.Delete(generation);
        // Une requête peut encore lire l'ancienne table : on la supprime un peu plus tard.
        Defer(TimeSpan.FromSeconds(60), $"drop {table}", () => Exec($"DROP TABLE IF EXISTS {table}", _engine));

        _log.LogDebug("{Signal}: {Rows} lignes → {File} en {Ms} ms", Name, rows, file, sw.ElapsedMilliseconds);
    }

    private void WriteParquet(string select, string file, SegmentIndex index, DuckDBConnection? connection = null)
    {
        var tmp = file + ".tmp";
        using (var cmd = (connection ?? _writer!).CreateCommand())
        {
            cmd.CommandText = $"COPY ({select}) TO {Sql.Path(tmp)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)";
            cmd.ExecuteNonQuery();
        }
        File.WriteAllBytes(file + ".idx", JsonSerializer.SerializeToUtf8Bytes(index));
        File.Move(tmp, file, overwrite: true);
    }

    // ------------------------------------------------------------------ maintenance

    /// <summary>Fusionne les petits segments d'une heure terminée en un seul fichier trié.</summary>
    public async Task CompactAsync(bool force = false)
    {
        await Task.Yield();
        var limit = DateTime.UtcNow.AddMinutes(-_options.CompactionDelayMinutes);
        var groups = _snapshot.Segments
            .GroupBy(s => s.Partition)
            .Where(g => g.Count() > 1 && (force || PartitionEnd(g.Key) < limit))
            .ToList();
        if (groups.Count == 0) return;

        using var conn = _engine.Connect();
        foreach (var group in groups)
        {
            var sources = group.ToList();
            var sw = Stopwatch.StartNew();
            var index = new SegmentIndex();
            foreach (var s in sources) index.Merge(s.Index);
            var file = Path.Combine(group.Key, $"cmp-{DateTime.UtcNow.Ticks}.parquet");
            var list = string.Join(", ", sources.Select(s => Sql.Path(s.Path)));
            WriteParquet($"SELECT {_schema.ColumnNames} FROM read_parquet([{list}], union_by_name = true) ORDER BY ts", file, index, conn);

            var merged = new Segment(file, group.Key, index, new FileInfo(file).Length);
            lock (_snapLock)
            {
                var remaining = _snapshot.Segments.RemoveRange(sources);
                _snapshot = _snapshot with { Segments = remaining.Add(merged) };
            }
            foreach (var s in sources) DeferFileDeletion(s.Path);
            _log.LogInformation("{Signal}: {Count} segments compactés ({Rows} lignes) en {Ms} ms", Name, sources.Count, index.Rows, sw.ElapsedMilliseconds);
        }
    }

    private static DateTime PartitionEnd(string partitionDir)
    {
        var hour = Path.GetFileName(partitionDir);
        var day = Path.GetFileName(Path.GetDirectoryName(partitionDir));
        if (DateTime.TryParseExact($"{day} {hour}", "yyyy-MM-dd HH", CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var start))
            return start.AddHours(1);
        return DateTime.MaxValue;
    }

    public void ApplyRetention(DateTime cutoff)
    {
        var expired = _snapshot.Segments.Where(s => s.Index.MaxTs < cutoff).ToList();
        if (expired.Count == 0) return;
        RemoveSegments(expired);
        _log.LogInformation("{Signal}: {Count} segments expirés supprimés", Name, expired.Count);
    }

    public void RemoveSegments(IReadOnlyCollection<Segment> segments)
    {
        lock (_snapLock)
        {
            _snapshot = _snapshot with { Segments = _snapshot.Segments.RemoveRange(segments) };
        }
        foreach (var s in segments) DeferFileDeletion(s.Path);
    }

    private void DeferFileDeletion(string path) =>
        Defer(TimeSpan.FromSeconds(120), $"delete {path}", () =>
        {
            File.Delete(path);
            TryDelete(path + ".idx");
            var dir = Path.GetDirectoryName(path)!;
            if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir);
        });

    private void Defer(TimeSpan delay, string what, Action action) => _deferred.Enqueue((DateTime.UtcNow + delay, what, action));

    private void RunDeferred(bool force)
    {
        var count = _deferred.Count;
        for (var i = 0; i < count && _deferred.TryDequeue(out var job); i++)
        {
            if (!force && job.Due > DateTime.UtcNow) { _deferred.Enqueue(job); continue; }
            try { job.Action(); }
            catch (IOException) when (!force) { _deferred.Enqueue((DateTime.UtcNow.AddSeconds(30), job.What, job.Action)); }
            catch (Exception ex) { _log.LogDebug(ex, "Tâche différée en échec : {What}", job.What); }
        }
    }

    // ------------------------------------------------------------------ requêtes

    /// <summary>
    /// Sous-requête SQL couvrant les données du snapshot, en écartant les segments rejetés par <paramref name="keep"/>.
    /// </summary>
    public string Source(StoreSnapshot snapshot, Func<SegmentIndex, bool>? keep = null)
    {
        var cols = _schema.ColumnNames;
        var parts = new List<string>();
        var files = snapshot.Segments.Where(s => keep is null || keep(s.Index)).Select(s => Sql.Path(s.Path)).ToList();
        if (files.Count > 0) parts.Add($"SELECT {cols} FROM read_parquet([{string.Join(", ", files)}], union_by_name = true)");
        foreach (var t in snapshot.HotTables) parts.Add($"SELECT {cols} FROM {t}");
        if (parts.Count == 0) parts.Add($"SELECT {cols} FROM {_schema.Name}_empty");
        return "(" + string.Join(" UNION ALL ", parts) + ")";
    }

    private void Exec(string sql, DuckDbEngine? engine = null)
    {
        if (engine != null) { engine.Execute(sql); return; }
        using var cmd = _writer!.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.TryComplete();
        _stop.Cancel();
        if (_writerTask != null) await _writerTask.ConfigureAwait(false);
        if (_timerTask != null) await _timerTask.ConfigureAwait(false);
        RunDeferred(force: true);
        _wal.Dispose();
        _writer?.Dispose();
    }
}
