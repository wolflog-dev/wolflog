using DuckDB.NET.Data;

namespace Wolflog.Server.Storage;

internal static class AppendExtensions
{
    extension(IDuckDBAppenderRow row)
    {
        /// <summary>Chaîne ou NULL.</summary>
        public IDuckDBAppenderRow Str(string? value) =>
            value is null ? row.AppendNullValue() : row.AppendValue(value);
    }
}
