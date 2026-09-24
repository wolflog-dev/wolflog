import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

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

export interface ErrorGroup {
  fingerprint: string;
  exceptionType: string;
  message: string | null;
  service: string;
  count: number;
  crashes: number;
  firstSeen: string;
  lastSeen: string;
  services: number;
}

export interface ErrorOccurrence {
  ts: string;
  service: string;
  host: string | null;
  version: string | null;
  traceId: string | null;
  isCrash: boolean;
  message: string | null;
}

export interface ErrorDetail {
  group: ErrorGroup;
  latest: LogItem | null;
  occurrences: ErrorOccurrence[];
  histogram: Histogram;
}

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

export interface Me {
  authEnabled: boolean;
  authenticated: boolean;
  user: string | null;
}

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

export type PanelType = 'custom' | 'http' | 'metric' | 'logs' | 'logs-table' | 'errors' | 'stat';

export interface Panel {
  id: string;
  title: string;
  type: PanelType;
  width: number;
  height: 's' | 'm' | 'l';
  service?: string | null;
  query?: string | null;
  level?: string | null;
  metric?: string | null;
  stat?: string | null;
  groupBy?: string | null;
  statusClass?: string | null;
  outgoing?: boolean;
  source?: 'http' | 'logs' | 'errors' | null;
  // Requête personnalisée
  dataSource?: DataSource | null;
  aggregate?: string | null;
  field?: string | null;
  view?: CustomView | null;
  limit?: number | null;
}

export type DataSource = 'logs' | 'spans' | 'metrics';
export type CustomView = 'timeseries' | 'bars' | 'top' | 'table' | 'stat';

export interface CustomRow {
  group: string;
  value: number | null;
  count: number;
}

export interface CustomResult {
  view: CustomView;
  unit: string | null;
  stepSeconds: number;
  times: string[] | null;
  series: { name: string; group: string; values: (number | null)[] }[] | null;
  rows: CustomRow[] | null;
  value: number | null;
  count: number;
}

export interface FieldInfo {
  key: string;
  label: string;
  kind: 'text' | 'number';
  builtin: boolean;
  seen: number;
}

export interface FieldValue {
  value: string;
  count: number;
}

export interface CustomQueryParams {
  source: DataSource;
  filter?: string | null;
  agg: string;
  field?: string | null;
  groupBy?: string | null;
  view: CustomView;
  limit?: number | null;
  service?: string | null;
}

export interface Dashboard {
  id: string;
  name: string;
  description?: string | null;
  panels: Panel[];
  updatedAt?: string;
}

export interface DashboardInfo {
  id: string;
  name: string;
  description: string | null;
  panels: number;
  updatedAt: string;
}

export interface Range {
  from: string;
  to: string;
}

type Params = Record<string, string | number | boolean | null | undefined>;

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  private params(p: Params): HttpParams {
    let hp = new HttpParams();
    for (const [k, v] of Object.entries(p)) {
      if (v !== null && v !== undefined && v !== '') hp = hp.set(k, String(v));
    }
    return hp;
  }

  private get<T>(url: string, p: Params = {}): Observable<T> {
    return this.http.get<T>(url, { params: this.params(p) });
  }

  me() { return this.get<Me>('/api/auth/me'); }
  login(username: string, password: string) { return this.http.post('/api/auth/login', { username, password }); }
  logout() { return this.http.post('/api/auth/logout', {}); }

  logs(r: Range, q: string, level: string, service: string, before?: string | null, limit = 200) {
    return this.get<LogPage>('/api/logs', { ...r, q, level, service, before, limit });
  }
  logHistogram(r: Range, q: string, level: string, service: string) {
    return this.get<Histogram>('/api/logs/histogram', { ...r, q, level, service });
  }
  traces(r: Range, p: { service?: string; q?: string; minMs?: number | null; errors?: boolean }) {
    return this.get<TraceSummary[]>('/api/traces', { ...r, ...p });
  }
  trace(id: string, around?: string | null) { return this.get<TraceDetail>(`/api/traces/${id}`, { around }); }
  errors(r: Range, q: string, service: string) { return this.get<ErrorGroup[]>('/api/errors', { ...r, q, service }); }
  error(fp: string, r: Range) { return this.get<ErrorDetail>(`/api/errors/${fp}`, { ...r }); }
  metrics(r: Range, service: string) { return this.get<MetricInfo[]>('/api/metrics', { ...r, service }); }
  metricKeys(r: Range, name: string) { return this.get<string[]>('/api/metrics/keys', { ...r, name }); }
  metricSeries(r: Range, name: string, service: string, groupBy: string, stat: string) {
    return this.get<MetricData>('/api/metrics/series', { ...r, name, service, groupBy, stat });
  }
  requests(r: Range, f: HttpQuery, limit = 300) {
    return this.get<HttpRequestItem[]>('/api/requests', { ...r, ...f, limit });
  }
  requestSummary(r: Range, f: HttpQuery) { return this.get<HttpSummary>('/api/requests/summary', { ...r, ...f }); }
  requestSeries(r: Range, f: HttpQuery, stat: string, groupBy: string) {
    return this.get<MetricData>('/api/requests/series', { ...r, ...f, stat, groupBy });
  }
  customQuery(r: Range, q: CustomQueryParams) { return this.get<CustomResult>('/api/query', { ...r, ...q }); }
  fields(r: Range, source: DataSource) { return this.get<FieldInfo[]>('/api/fields', { ...r, source }); }
  fieldValues(r: Range, source: DataSource, key: string) { return this.get<FieldValue[]>('/api/fields/values', { ...r, source, key }); }
  environments() { return this.get<string[]>('/api/environments'); }
  dashboards() { return this.get<DashboardInfo[]>('/api/dashboards'); }
  dashboard(id: string) { return this.get<Dashboard>(`/api/dashboards/${id}`); }
  createDashboard(d: Partial<Dashboard>) { return this.http.post<Dashboard>('/api/dashboards', d); }
  saveDashboard(d: Dashboard) { return this.http.put<Dashboard>(`/api/dashboards/${d.id}`, d); }
  deleteDashboard(id: string) { return this.http.delete(`/api/dashboards/${id}`); }
  services(r: Range) { return this.get<ServiceInfo[]>('/api/services', { ...r }); }
  overview(r: Range) { return this.get<Overview>('/api/overview', { ...r }); }
  system() { return this.get<SystemStats>('/api/system'); }
  integration() { return this.get<Integration>('/api/system/integration'); }
  flush() { return this.http.post('/api/system/flush', {}); }
  compact() { return this.http.post('/api/system/compact', {}); }
}
