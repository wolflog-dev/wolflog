namespace Wolflog.Server.Sources;

/// <summary>Entrée normalisée, quelle que soit la source.</summary>
public sealed class ParsedEntry
{
    public DateTime Ts { get; set; } = DateTime.UtcNow;
    /// <summary>Sévérité OpenTelemetry (1-24) : 5 debug, 9 info, 13 warn, 17 error, 21 fatal.</summary>
    public int Severity { get; set; } = 9;
    public string Body { get; set; } = "";
    public string? Service { get; set; }
    public string? Host { get; set; }
    public string? Category { get; set; }
    public Dictionary<string, string> Attributes { get; } = [];
    public HttpEntry? Http { get; set; }
}
