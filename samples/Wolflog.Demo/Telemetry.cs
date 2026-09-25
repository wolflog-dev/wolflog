internal static class Telemetry
{
    public static readonly ActivitySource Source = new("Wolflog.Demo");
    public static readonly Meter Meter = new("Wolflog.Demo");
    public static readonly Counter<long> Orders = Meter.CreateCounter<long>("demo.orders", description: "Commandes calculées");
    public static readonly Histogram<double> Amount = Meter.CreateHistogram<double>("demo.order.amount", unit: "EUR");

    /// <summary>Requête SQL simulée, avec les attributs sémantiques d'une vraie base PostgreSQL.</summary>
    public static async Task Query(string sql, int minMs, int maxMs)
    {
        using var db = Source.StartActivity($"SELECT shop", ActivityKind.Client);
        db?.SetTag("db.system.name", "postgresql");
        db?.SetTag("db.namespace", "shop");
        db?.SetTag("db.query.text", sql);
        db?.SetTag("server.address", "db.interne");
        await Task.Delay(Random.Shared.Next(minMs, maxMs));
    }
}
