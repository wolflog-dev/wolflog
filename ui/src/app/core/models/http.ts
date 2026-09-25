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
