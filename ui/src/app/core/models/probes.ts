/** Sondes de disponibilité. */
export interface Probe {
  id: string;
  name: string;
  enabled: boolean;
  type: 'http' | 'tcp';
  target: string;
  method: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatus: string;
  expectedText: string | null;
  failuresBeforeDown: number;
  service: string | null;
  ignoreTlsErrors: boolean;
}

export interface ProbeResult {
  at: string;
  ok: boolean;
  durationMs: number;
  status: number | null;
  error: string | null;
  certificateDays: number | null;
}

export interface ProbeInfo {
  probe: Probe;
  status: 'up' | 'down' | 'unknown' | 'paused';
  since: string | null;
  last: ProbeResult | null;
  recent: ProbeResult[] | null;
  stats: { checks: number; uptime: number | null; avgMs: number | null; p95Ms: number | null; buckets: (number | null)[] } | null;
}
