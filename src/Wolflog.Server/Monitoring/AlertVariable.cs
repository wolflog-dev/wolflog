namespace Wolflog.Server.Monitoring;

/// <summary>Variable insérable dans un modèle de message : {{Name}}.</summary>
public sealed record AlertVariable(string Name, string Label, string Description, string Sample);
