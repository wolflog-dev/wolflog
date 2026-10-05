using DuckDB.NET.Data;

namespace Wolflog.Server.Storage;

/// <summary>Décrit comment un type de signal est stocké : colonnes, écriture, indexation, décodage du WAL.</summary>
public abstract class SignalSchema<TRow>
{
    public abstract string Name { get; }
    /// <summary>Définition des colonnes (DDL DuckDB).</summary>
    public abstract string Columns { get; }
    /// <summary>
    /// Version des colonnes, à augmenter quand on en ajoute (toujours à la fin de <see cref="Columns"/>) :
    /// les segments Parquet écrits avant restent lisibles, les colonnes qui leur manquent valent NULL.
    /// </summary>
    public virtual int Version => 1;
    public abstract void Append(IDuckDBAppenderRow row, TRow r);
    public abstract void Index(SegmentIndex index, TRow r);
    public abstract List<TRow> Decode(ReadOnlySpan<byte> payload);
    public virtual bool HasTextIndex => false;

    public string ColumnNames => field ??= string.Join(", ",
        Columns.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(c => c.Split(' ')[0]));
}
