/** Objectifs de service (SLO). */
export interface Slo {
  id: string;
  name: string;
  kind: 'availability' | 'latency';
  source: 'http' | 'probe';
  service: string | null;
  route: string | null;
  probeId: string | null;
  targetPercent: number;
  latencyMs: number;
  windowDays: number;
  description: string | null;
}

export interface SloStatus {
  id: string;
  total: number;
  bad: number;
  sli: number | null;
  targetPercent: number;
  budgetRemaining: number | null;
  burnRate1h: number | null;
  burnRate6h: number | null;
  state: 'ok' | 'warning' | 'breached';
}

export interface SloDetail {
  slo: Slo;
  status: SloStatus;
  history: { t: string; sli: number | null; budgetRemaining: number | null }[];
}
