namespace Wolflog.Server.Storage;

public sealed class SpanRow
{
    public DateTime Ts;
    public long DurationNs;
    public string TraceId = "";
    public string SpanId = "";
    public string? ParentSpanId;
    public string Service = "";
    public string? Host;
    public string? Env;
    public string? Version;
    public string Name = "";
    public byte Kind;
    public byte StatusCode;
    public string? StatusMessage;
    public string? Scope;
    public string Attributes = "{}";
    public string Events = "[]";
    public string Resource = "{}";
}
