using DuckDB.NET.Data;

namespace Wolflog.Server.Storage;

/// <summary>Base DuckDB embarquée (en mémoire) : tables "chaudes" + lecture des segments Parquet.</summary>
public sealed class DuckDbEngine : IDisposable
{
    private readonly DuckDBConnection _root;

    public DuckDbEngine(string tempDirectory, string? memoryLimit, int threads)
    {
        Directory.CreateDirectory(tempDirectory);
        _root = new DuckDBConnection("DataSource=:memory:");
        _root.Open();
        Execute($"SET temp_directory = {Sql.Str(tempDirectory)}");
        Execute("SET parquet_metadata_cache = true");
        Execute("SET preserve_insertion_order = false");
        // Par défaut DuckDB s'autorise 80 % de la RAM : trop pour un service qui cohabite avec d'autres.
        // Au-delà de la limite, les requêtes lourdes débordent sur disque (temp_directory) au lieu d'échouer.
        if (string.IsNullOrWhiteSpace(memoryLimit))
        {
            var total = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
            var mb = Math.Clamp(total / 4 / 1024 / 1024, 512, 4096);
            memoryLimit = $"{mb}MB";
        }
        Execute($"SET memory_limit = {Sql.Str(memoryLimit)}");
        if (threads > 0) Execute($"SET threads = {threads}");
    }

    /// <summary>Nouvelle connexion sur la même base (une par thread / requête).</summary>
    public DuckDBConnection Connect()
    {
        var c = _root.Duplicate();
        if (c.State != System.Data.ConnectionState.Open) c.Open();
        return c;
    }

    /// <summary>Exécute une commande sur une connexion dédiée (sûr depuis n'importe quel thread).</summary>
    public void Execute(string sql)
    {
        using var conn = Connect();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public void Dispose() => _root.Dispose();
}
