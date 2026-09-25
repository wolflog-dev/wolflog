namespace Wolflog.Server.Sources;

/// <summary>Reçoit les entrées lues par une source (écriture locale ou envoi à un serveur Wolflog distant).</summary>
public delegate Task EntrySink(IReadOnlyList<ParsedEntry> entries, CancellationToken ct);
