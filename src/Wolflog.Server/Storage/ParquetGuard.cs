using DuckDB.NET.Data;

namespace Wolflog.Server.Storage;

/// <summary>
/// Contrôle d'un segment Parquet venu de l'extérieur (restauration d'une sauvegarde) avant que DuckDB ne le lise.
/// Seules les métadonnées (pied du fichier) sont lues : aucune donnée n'est décompressée pendant le contrôle.
/// </summary>
public static class ParquetGuard
{
    /// <summary>
    /// Codecs acceptés. BROTLI est refusé : DuckDB embarque un décodeur Brotli sans le correctif de CVE-2026-111497
    /// (« Node2Shell ») ; Wolflog écrit ses segments en ZSTD et n'en a jamais besoin.
    /// </summary>
    private static readonly HashSet<string> AllowedCodecs = ["ZSTD", "UNCOMPRESSED", "SNAPPY", "GZIP", "LZ4", "LZ4_RAW"];

    /// <summary>Raison du refus, ou null si le segment peut être lu.</summary>
    public static string? Problem(string file)
    {
        try
        {
            using var connection = new DuckDBConnection("DataSource=:memory:");
            connection.Open();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = $"SELECT DISTINCT upper(CAST(compression AS VARCHAR)) FROM parquet_metadata({Sql.Path(file)})";
            using var reader = cmd.ExecuteReader();
            var refused = new List<string>();
            while (reader.Read())
            {
                var codec = reader.IsDBNull(0) ? "INCONNU" : reader.GetString(0);
                if (!AllowedCodecs.Contains(codec)) refused.Add(codec);
            }
            return refused.Count > 0 ? $"compression {string.Join(", ", refused)} refusée" : null;
        }
        catch (DuckDBException ex)
        {
            return "segment Parquet illisible : " + ex.Message.Split('\n')[0];
        }
    }
}
