namespace Wolflog.Server.Query;

public sealed record FieldInfo(string Key, string Label, string Kind, bool Builtin, long Seen);
