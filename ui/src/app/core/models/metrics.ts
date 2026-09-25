/** Métriques et exemplaires. */
export interface MetricInfo {
  name: string;
  type: number;
  unit: string | null;
  description: string | null;
  points: number;
}

export interface MetricData {
  name: string;
  stat: string;
  unit: string | null;
  stepSeconds: number;
  times: string[];
  series: { name: string; group: string; values: (number | null)[] }[];
}

export interface ExemplarItem {
  ts: string;
  value: number;
  traceId: string;
  spanId: string | null;
  service: string;
  attributes: string;
}
