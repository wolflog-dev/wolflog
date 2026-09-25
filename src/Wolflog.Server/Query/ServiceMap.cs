namespace Wolflog.Server.Query;

public sealed record ServiceMap(IReadOnlyList<MapNode> Nodes, IReadOnlyList<MapEdge> Edges, double Seconds);
