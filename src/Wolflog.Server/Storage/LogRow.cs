namespace Wolflog.Server.Storage;

public sealed class LogRow
{
    public DateTime Ts;
    public string Service = "";
    public string? Host;
    public string? Env;
    public string? Version;
    public string? InstanceId;
    public byte Severity;
    public string Body = "";
    public string? TraceId;
    public string? SpanId;
    public string? Category;
    public string? ExceptionType;
    public string? ExceptionMessage;
    public string? ExceptionStack;
    public string? Fingerprint;
    public bool IsCrash;
    public string Attributes = "{}";
    public string Resource = "{}";
}
