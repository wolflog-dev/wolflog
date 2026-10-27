using DuckDB.NET.Data;

namespace Wolflog.Tests;

/// <summary>Segments Parquet réels pour les tests.</summary>
public static class TestParquet
{
    /// <summary>Segment avec le codec demandé (écriture seulement : aucun décodage).</summary>
    public static void Write(string file, string codec)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        using var connection = new DuckDBConnection("DataSource=:memory:");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"COPY (SELECT range AS x, 'texte ' || range AS y FROM range(100)) TO {Sql.Path(file)} (FORMAT PARQUET, COMPRESSION {codec})";
        cmd.ExecuteNonQuery();
    }
}
