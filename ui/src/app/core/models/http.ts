/** Requêtes HTTP. */
export interface HttpRequestItem {
  ts: string;
  traceId: string;
  spanId: string;
  service: string;
  method: string;
  route: string | null;
  target: string;
  status: number | null;
  durationMs: number;
  error: boolean;
  hasBody: boolean;
  /** Type de route : api, page, fichier statique, santé. */
  kind: RouteKind;
  host: string | null;
}

export type RouteKind = 'api' | 'page' | 'static' | 'health';

/** Curseur de pagination : plus anciennes (before) ou plus récentes (after) qu'une requête donnée. */
export interface HttpCursor {
  before?: string;
  beforeSpan?: string;
  after?: string;
  afterSpan?: string;
}

export interface HttpSummary {
  count: number;
  ratePerSecond: number;
  errors: number;
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface HttpQuery {
  service?: string | null;
  q?: string | null;
  status?: string | null;
  minMs?: number | null;
  direction?: 'in' | 'out';
}
