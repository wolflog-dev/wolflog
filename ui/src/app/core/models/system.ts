/** Services, vue d'ensemble, état du serveur et santé. */
import type { ErrorGroup } from './errors';
import type { Histogram } from './logs';

export interface ServiceInfo {
  name: string;
  logs: number;
  errors: number;
  spans: number;
  spanErrors: number;
  p95Ms: number | null;
  lastSeen: string | null;
}

export interface Overview {
  logs: number;
  errors: number;
  crashes: number;
  spans: number;
  traces: number;
  p95Ms: number | null;
  logHistogram: Histogram;
  services: ServiceInfo[];
  topErrors: ErrorGroup[];
}

export interface StoreStats {
  name: string;
  ingestedRows: number;
  hotRows: number;
  segments: number;
  diskBytes: number;
  oldest: string | null;
}

export interface SystemStats {
  startedAt: string;
  dataDirectory: string;
  diskBytes: number;
  memoryBytes: number;
  liveTailClients: number;
  stores: StoreStats[];
  version: string;
}

export interface Integration {
  endpoint: string;
  apiKey: string | null;
  authEnabled: boolean;
}

export interface HealthReport {
  status: 'ok' | 'warning' | 'critical';
  checks: { id: string; name: string; status: 'ok' | 'warning' | 'critical'; message: string; value: number | null }[];
  at: string;
}
