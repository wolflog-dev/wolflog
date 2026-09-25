/** Traces et spans. */
import type { LogItem } from './logs';

export interface TraceSummary {
  traceId: string;
  start: string;
  durationMs: number;
  spans: number;
  rootName: string;
  rootService: string;
  services: number;
  errors: number;
}

export interface SpanItem {
  ts: string;
  durationMs: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  host: string | null;
  name: string;
  kind: number;
  statusCode: number;
  statusMessage: string | null;
  scope: string | null;
  attributes: string;
  events: string;
  resource: string;
}

export interface TraceDetail {
  traceId: string;
  spans: SpanItem[];
  logs: LogItem[];
}
