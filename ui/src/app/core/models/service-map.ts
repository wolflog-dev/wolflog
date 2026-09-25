/** Carte des services. */
export interface MapNode {
  id: string;
  name: string;
  kind: 'service' | 'database' | 'queue' | 'external';
  requests: number;
  errors: number;
  p95Ms: number | null;
  detail: string | null;
}

export interface MapEdge {
  source: string;
  target: string;
  calls: number;
  errors: number;
  p95Ms: number | null;
}

export interface ServiceMap {
  nodes: MapNode[];
  edges: MapEdge[];
  seconds: number;
}
