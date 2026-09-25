namespace Wolflog.Server.Storage;

public sealed class MetricRow
{
    public DateTime Ts;
    public string Service = "";
    public string? Host;
    public string? Env;
    public string Name = "";
    public string? Unit;
    public string? Description;
    /// <summary>1 gauge, 2 sum, 3 histogram, 4 exponential histogram, 5 summary.</summary>
    public byte Type;
    /// <summary>1 delta, 2 cumulative.</summary>
    public byte Temporality;
    public bool Monotonic;
    public double? Value;
    public long? Count;
    public double? Sum;
    public double? Min;
    public double? Max;
    public string? Buckets;
    public string Attributes = "{}";
    /// <summary>JSON [{t, v, trace, span}] ou null.</summary>
    public string? Exemplars;
}
