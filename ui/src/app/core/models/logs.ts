/** Logs et histogrammes. */
export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogItem {
  ts: string;
  service: string;
  host: string | null;
  env: string | null;
  version: string | null;
  severity: number;
  level: Level;
  body: string;
  traceId: string | null;
  spanId: string | null;
  category: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
  exceptionStack: string | null;
  fingerprint: string | null;
  isCrash: boolean;
  attributes: string;
  resource: string;
}

export interface LogPage {
  items: LogItem[];
  nextBefore: string | null;
  elapsedMs: number;
  scannedSegments: number;
  totalSegments: number;
}

export interface HistogramBucket {
  t: string;
  trace: number;
  debug: number;
  info: number;
  warn: number;
  error: number;
  fatal: number;
}

export interface Histogram {
  stepSeconds: number;
  buckets: HistogramBucket[];
}
