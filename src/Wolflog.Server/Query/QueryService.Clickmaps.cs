namespace Wolflog.Server.Query;

/// <summary>Cartes de chaleur : clics et défilement agrégés par page et par appareil.</summary>
public sealed partial class QueryService
{
    /// <summary>Taille des cases d'agrégation des clics : 0,5 % de la largeur × 8 px.</summary>
    private const int ClickBinX = 50, ClickBinY = 8;

    private (string Source, string Where) ClickScope(DateTime from, DateTime to, AnalyticsFilter f, string? device, string? path, string extra)
    {
        var (source, where) = AnalyticsScope(from, to, f, extra);
        if (!string.IsNullOrEmpty(device)) where.Add($"device = {Sql.Str(device)}");
        if (path is not null) where.Add($"path = {Sql.Str(path)}");
        return (source, string.Join(" AND ", where));
    }

    public List<ClickmapPage> ClickmapPages(DateTime from, DateTime to, AnalyticsFilter f, string? device, CancellationToken ct)
    {
        var (source, where) = ClickScope(from, to, f, device, null, "kind IN (3, 4)");
        var list = new List<ClickmapPage>();
        Read($"""
            SELECT path, count(*) FILTER (WHERE kind = 3) AS clicks, count(*) FILTER (WHERE kind = 4),
                   count(*) FILTER (WHERE rage), count(*) FILTER (WHERE dead)
            FROM {source} WHERE {where} GROUP BY path ORDER BY clicks DESC, 3 DESC LIMIT 100
            """, ct, r => list.Add(new ClickmapPage(r.GetString(0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4))));
        return list;
    }

    public ClickmapReport Clickmap(DateTime from, DateTime to, AnalyticsFilter f, string path, string? device, CancellationToken ct)
    {
        // Gabarit représentatif : largeur de fenêtre la plus fréquente, hauteurs médianes.
        var (shapeSource, shapeWhere) = ClickScope(from, to, f, device, path, "kind IN (3, 4) AND vw IS NOT NULL");
        int width = 1280, fold = 800, height = 1600;
        string? host = null;
        Read($"SELECT mode(vw // 20 * 20), median(vh), median(doc_h), mode(hostname) FROM {shapeSource} WHERE {shapeWhere}", ct, r =>
        {
            host = Str(r, 3);
            if (!r.IsDBNull(0)) width = Math.Clamp(System.Convert.ToInt32(r.GetValue(0)), 320, 2560);
            if (!r.IsDBNull(1)) fold = Math.Max(300, System.Convert.ToInt32(r.GetValue(1)));
            if (!r.IsDBNull(2)) height = Math.Clamp(System.Convert.ToInt32(r.GetValue(2)), 400, 20_000);
        });

        var (source, clickWhere) = ClickScope(from, to, f, device, path, "kind = 3");
        var points = new List<ClickmapPoint>();
        Read($"""
            SELECT (x // {ClickBinX}) * {ClickBinX} + {ClickBinX / 2} AS bx, (y // {ClickBinY}) * {ClickBinY} + {ClickBinY / 2} AS b_y, count(*) AS n
            FROM {source} WHERE {clickWhere} AND x IS NOT NULL AND y IS NOT NULL GROUP BY bx, b_y ORDER BY n DESC LIMIT 20000
            """, ct, r => points.Add(new ClickmapPoint(System.Convert.ToInt32(r.GetValue(0)), System.Convert.ToInt32(r.GetValue(1)), r.GetInt64(2))));

        var elements = new List<ClickmapElement>();
        Read($"""
            SELECT selector, max(label), count(*) AS n, count(*) FILTER (WHERE rage), count(*) FILTER (WHERE dead)
            FROM {source} WHERE {clickWhere} AND selector IS NOT NULL GROUP BY selector ORDER BY n DESC LIMIT 30
            """, ct, r => elements.Add(new ClickmapElement(Str(r, 0), Str(r, 1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4))));

        var (_, allWhere) = ClickScope(from, to, f, device, path, "kind IN (3, 4)");
        long clicks = 0, views = 0, rage = 0, dead = 0;
        double avg = 0;
        Read($"""
            SELECT count(*) FILTER (WHERE kind = 3), count(*) FILTER (WHERE kind = 4), count(*) FILTER (WHERE rage), count(*) FILTER (WHERE dead),
                   coalesce(avg(depth) FILTER (WHERE kind = 4), 0)
            FROM {source} WHERE {allWhere}
            """, ct, r =>
        {
            clicks = r.GetInt64(0);
            views = r.GetInt64(1);
            rage = r.GetInt64(2);
            dead = r.GetInt64(3);
            avg = System.Convert.ToDouble(r.GetValue(4));
        });

        // Part des pages vues ayant atteint chaque profondeur (pas de 5 %).
        var (_, scrollWhere) = ClickScope(from, to, f, device, path, "kind = 4 AND depth IS NOT NULL");
        var byDepth = new Dictionary<int, long>();
        Read($"SELECT depth // 5 * 5 AS b, count(*) FROM {source} WHERE {scrollWhere} GROUP BY b", ct,
            r => byDepth[System.Convert.ToInt32(r.GetValue(0))] = r.GetInt64(1));
        var scroll = new List<ScrollReach>();
        long cumulative = 0;
        for (var d = 100; d >= 0; d -= 5)
        {
            cumulative += byDepth.GetValueOrDefault(d);
            scroll.Add(new ScrollReach(d, views > 0 ? (double)cumulative / views : 0));
        }
        scroll.Reverse();

        return new ClickmapReport(host, width, height, fold, clicks, views, rage, dead, avg, points, elements, scroll);
    }

    /// <summary>Éléments les plus frustrants du site : rage clicks (poids fort) puis dead clicks.</summary>
    public List<ClickmapFrustration> ClickmapFrustrations(DateTime from, DateTime to, AnalyticsFilter f, string? device, CancellationToken ct)
    {
        var (source, where) = ClickScope(from, to, f, device, null, "kind = 3 AND (rage OR dead)");
        var list = new List<ClickmapFrustration>();
        Read($"""
            SELECT path, selector, max(label), count(*) FILTER (WHERE rage) AS r, count(*) FILTER (WHERE dead) AS d
            FROM {source} WHERE {where} GROUP BY path, selector ORDER BY r * 10 + d DESC LIMIT 15
            """, ct, r => list.Add(new ClickmapFrustration(r.GetString(0), Str(r, 1), Str(r, 2), r.GetInt64(3), r.GetInt64(4))));
        return list;
    }
}
