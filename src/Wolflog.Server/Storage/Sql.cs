namespace Wolflog.Server.Storage;

/// <summary>Aide à la construction de SQL littéral sûr.</summary>
public static class Sql
{
    public static string Str(string s) => "'" + s.Replace("'", "''") + "'";

    public static string Path(string p) => Str(p.Replace('\\', '/'));

    public static string Ts(DateTime t) =>
        "TIMESTAMP '" + t.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss.ffffff", CultureInfo.InvariantCulture) + "'";

    public static string List(IEnumerable<string> values)
    {
        var sb = new StringBuilder("(");
        var first = true;
        foreach (var v in values)
        {
            if (!first) sb.Append(", ");
            sb.Append(Str(v));
            first = false;
        }
        return sb.Append(')').ToString();
    }

    public static string Like(string term) =>
        Str("%" + term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%");
}
