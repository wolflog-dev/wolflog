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
  status: ErrorStatus;
  assignedTo: string | null;
}

export type ErrorStatus = 'open' | 'regressed' | 'resolved' | 'ignored';

export interface ErrorList {
  items: ErrorGroup[];
  counts: { todo: number; resolved: number; ignored: number; mine: number; all: number };
}

export interface ErrorState {
  id: string;
  status: string;
  resolvedAt: string | null;
  assignedTo: string | null;
  note: string | null;
  updatedAt: string;
  history: { at: string; by: string | null; action: string }[];
}

export interface Person {
  username: string;
  displayName: string;
}

export interface Deployment {
  id: string;
  service: string;
  env: string | null;
  version: string;
  at: string;
  source: 'auto' | 'initial' | 'api';
  description: string | null;
  by: string | null;
}

export type SearchPage = 'logs' | 'requests' | 'traces' | 'errors';

export interface SavedSearch {
  id: string;
  name: string;
  page: SearchPage;
  params: Record<string, string>;
  owner: string | null;
  shared: boolean;
  mine: boolean;
}

export type Role = 'viewer' | 'editor' | 'admin';

export interface UserAccount {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  source: 'local' | 'sso';
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  kind: 'server' | 'browser';
  prefix: string;
  allowedOrigins: string[];
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
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
  state: ErrorState | null;
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
  displayName: string | null;
  role: Role | null;
  source: 'local' | 'sso' | null;
  mustChangePassword: boolean;
  sso: { name: string } | null;
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

export interface DashboardVariable {
  name: string;
  label?: string | null;
  field: string;
  source: DataSource;
  default?: string | null;
}

export interface Dashboard {
  id: string;
  name: string;
  description?: string | null;
  panels: Panel[];
  variables?: DashboardVariable[];
  updatedAt?: string;
}

export interface DashboardInfo {
  id: string;
  name: string;
  description: string | null;
  panels: number;
  updatedAt: string;
}

export type AlertKind = 'query' | 'http' | 'error' | 'silence' | 'probe' | 'slo' | 'health';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: AlertKind;
  severity: 'critical' | 'warning';
  service?: string | null;
  env?: string | null;
  source?: DataSource | null;
  filter?: string | null;
  aggregate?: string | null;
  field?: string | null;
  groupBy?: string | null;
  stat?: string | null;
  route?: string | null;
  perService?: boolean;
  includeRegressions?: boolean;
  crashesOnly?: boolean;
  targetId?: string | null;
  comparison: 'above' | 'below';
  threshold: number;
  windowMinutes: number;
  forMinutes: number;
  repeatMinutes: number;
  minCount: number;
  channels: string[];
  notifyResolved: boolean;
  runbook?: string | null;
  mutedUntil?: string | null;
  createdBy?: string | null;
}

export interface AlertStateItem {
  id: string;
  ruleId: string;
  key: string;
  status: 'ok' | 'pending' | 'firing';
  since: string;
  value: number | null;
  message: string | null;
  link: string | null;
}

export interface AlertRuleInfo {
  rule: AlertRule;
  status: 'ok' | 'pending' | 'firing' | 'disabled';
  firing: number;
  states: AlertStateItem[];
}

export interface ActiveAlert extends AlertStateItem {
  ruleName: string;
  severity: 'critical' | 'warning';
  muted: boolean;
  runbook: string | null;
}

export interface AlertEvaluation {
  key: string;
  breach: boolean;
  value: number | null;
  message: string;
  link: string | null;
}

export interface AlertEventItem {
  id: string;
  ruleId: string;
  ruleName: string;
  key: string;
  status: 'firing' | 'resolved';
  severity: string;
  at: string;
  value: number | null;
  message: string | null;
  link: string | null;
  notifiedChannels: string[];
}

export type ChannelType = 'email' | 'teams' | 'slack' | 'webhook';

export interface AlertChannel {
  id: string;
  name: string;
  type: ChannelType;
  target: string;
  default: boolean;
  lastSentAt?: string | null;
  lastErrorAt?: string | null;
  lastError?: string | null;
}

export interface NotificationSettings {
  publicUrl: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpSsl: boolean;
  smtpUser: string | null;
  smtpPassword?: string | null;
  from: string | null;
  hasPassword?: boolean;
}

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

export interface HealthReport {
  status: 'ok' | 'warning' | 'critical';
  checks: { id: string; name: string; status: 'ok' | 'warning' | 'critical'; message: string; value: number | null }[];
  at: string;
}

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

export interface ExemplarItem {
  ts: string;
  value: number;
  traceId: string;
  spanId: string | null;
  service: string;
  attributes: string;
}

export interface LogSourceConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: 'file' | 'syslog';
  path: string | null;
  format: string;
  startAtEnd: boolean;
  port: number;
  protocol: 'udp' | 'tcp' | 'both';
  service: string | null;
  env: string | null;
}

export interface SourceInfo {
  source: LogSourceConfig;
  status: { state: string; entries: number; lastEntryAt: string | null; lastError: string | null; lastErrorAt: string | null; files: number; detail: string | null };
}

export interface SourcePreview {
  files: string[];
  total: number;
  newest: string | null;
  entries: { ts: string; level: Level; body: string; service: string | null; exception: string | null;
    http: { method: string; path: string; status: number; durationMs: number } | null }[];
}

export interface ProfilingInstance {
  service: string;
  instance: string;
  host: string | null;
  version: string | null;
  runtime: string | null;
  lastSeen: string;
}

export interface ProfileInfo {
  id: string;
  service: string;
  instance: string;
  host: string | null;
  version: string | null;
  kind: 'cpu' | 'alloc';
  start: string;
  seconds: number;
  samples: number;
  total: number;
  error: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  requestedBy: string | null;
  requestedAt: string;
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
  errors(r: Range, q: string, service: string, status = 'all', limit = 200) {
    return this.get<ErrorList>('/api/errors', { ...r, q, service, status, limit });
  }
  setErrorState(fp: string, change: { status?: string; assignedTo?: string; unassign?: boolean; note?: string }) {
    return this.http.post<ErrorState>(`/api/errors/${fp}/state`, change);
  }
  setErrorsState(fingerprints: string[], status: string) { return this.http.post('/api/errors/state', { fingerprints, status }); }
  people() { return this.get<Person[]>('/api/people'); }
  deployments(r: Range, service?: string | null) { return this.get<Deployment[]>('/api/deployments', { ...r, service }); }
  declareDeployment(d: { service: string; env?: string | null; version: string; description?: string | null }) {
    return this.http.post<Deployment>('/api/deployments', d);
  }
  deleteDeployment(id: string) { return this.http.delete(`/api/deployments/${id}`); }
  searches(page?: SearchPage) { return this.get<SavedSearch[]>('/api/searches', { page }); }
  saveSearch(s: { name: string; page: SearchPage; params: Record<string, string>; shared: boolean }) {
    return this.http.post<SavedSearch>('/api/searches', s);
  }
  deleteSearch(id: string) { return this.http.delete(`/api/searches/${id}`); }
  /** URL de téléchargement (le navigateur envoie le cookie de session). */
  exportUrl(kind: 'logs' | 'requests', format: 'csv' | 'json', p: Params) {
    return `/api/${kind}/export?` + this.params({ ...p, format }).toString();
  }
  changePassword(current: string, next: string) { return this.http.post('/api/account/password', { current, next }); }
  users() { return this.get<UserAccount[]>('/api/admin/users'); }
  createUser(u: { username: string; displayName?: string; email?: string; role: Role }) {
    return this.http.post<{ user: UserAccount; temporaryPassword: string }>('/api/admin/users', u);
  }
  updateUser(id: string, u: Partial<{ displayName: string; email: string; role: Role; disabled: boolean }>) {
    return this.http.put<UserAccount>(`/api/admin/users/${id}`, u);
  }
  resetPassword(id: string) { return this.http.post<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`, {}); }
  deleteUser(id: string) { return this.http.delete(`/api/admin/users/${id}`); }
  apiKeys() { return this.get<{ configKeys: number; keys: ApiKeyInfo[] }>('/api/admin/keys'); }
  createApiKey(k: { name: string; kind: 'server' | 'browser'; origins?: string[] }) {
    return this.http.post<{ id: string; name: string; kind: string; prefix: string; key: string }>('/api/admin/keys', k);
  }
  alerts() { return this.get<{ rules: AlertRuleInfo[]; lastRunAt: string | null }>('/api/alerts'); }
  activeAlerts() { return this.get<{ items: ActiveAlert[]; firing: number }>('/api/alerts/active'); }
  alertHistory(r: Range, rule?: string | null) { return this.get<AlertEventItem[]>('/api/alerts/history', { ...r, rule }); }
  previewAlert(rule: Partial<AlertRule>) { return this.http.post<AlertEvaluation[]>('/api/alerts/preview', rule); }
  saveAlert(rule: Partial<AlertRule>) {
    return rule.id ? this.http.put<AlertRule>(`/api/alerts/${rule.id}`, rule) : this.http.post<AlertRule>('/api/alerts', rule);
  }
  deleteAlert(id: string) { return this.http.delete(`/api/alerts/${id}`); }
  muteAlert(id: string, minutes: number) { return this.http.post<AlertRule>(`/api/alerts/${id}/mute`, { minutes }); }
  runAlerts() { return this.http.post('/api/alerts/run', {}); }
  channels() { return this.get<AlertChannel[]>('/api/alert-channels'); }
  saveChannel(c: Partial<AlertChannel>) {
    return c.id ? this.http.put<AlertChannel>(`/api/alert-channels/${c.id}`, c) : this.http.post<AlertChannel>('/api/alert-channels', c);
  }
  deleteChannel(id: string) { return this.http.delete(`/api/alert-channels/${id}`); }
  testChannel(c: Partial<AlertChannel>) { return this.http.post('/api/alert-channels/test', c); }
  notificationSettings() { return this.get<NotificationSettings>('/api/notification-settings'); }
  saveNotificationSettings(s: NotificationSettings) { return this.http.put('/api/notification-settings', s); }
  probes(r: Range, buckets = 60) { return this.get<ProbeInfo[]>('/api/probes', { ...r, buckets }); }
  saveProbe(p: Partial<Probe>) { return p.id ? this.http.put<Probe>(`/api/probes/${p.id}`, p) : this.http.post<Probe>('/api/probes', p); }
  deleteProbe(id: string) { return this.http.delete(`/api/probes/${id}`); }
  testProbe(p: Partial<Probe>) { return this.http.post<ProbeResult>('/api/probes/test', p); }
  slos() { return this.get<{ slo: Slo; status: SloStatus }[]>('/api/slos'); }
  slo(id: string) { return this.get<SloDetail>(`/api/slos/${id}`); }
  saveSlo(s: Partial<Slo>) { return s.id ? this.http.put<Slo>(`/api/slos/${s.id}`, s) : this.http.post<Slo>('/api/slos', s); }
  previewSlo(s: Partial<Slo>) { return this.http.post<SloStatus>('/api/slos/preview', s); }
  deleteSlo(id: string) { return this.http.delete(`/api/slos/${id}`); }
  vigilHealth() { return this.get<HealthReport>('/api/health/vigil'); }
  backupUrl(data: boolean) { return '/api/admin/backup' + (data ? '?data=true' : ''); }
  restore(file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<{ configFiles: number; dataFiles: number }>('/api/admin/restore', form);
  }
  sources() { return this.get<SourceInfo[]>('/api/sources'); }
  saveSource(s: Partial<LogSourceConfig>) {
    return s.id ? this.http.put<LogSourceConfig>(`/api/sources/${s.id}`, s) : this.http.post<LogSourceConfig>('/api/sources', s);
  }
  deleteSource(id: string) { return this.http.delete(`/api/sources/${id}`); }
  previewSource(s: Partial<LogSourceConfig>) { return this.http.post<SourcePreview>('/api/sources/preview', { type: s.type, path: s.path, format: s.format }); }
  profilingInstances() { return this.get<ProfilingInstance[]>('/api/profiling/instances'); }
  profiles(service?: string) { return this.get<ProfileInfo[]>('/api/profiles', { service }); }
  profile(id: string) { return this.get<{ info: ProfileInfo; stacks: { s: string; v: number }[] }>(`/api/profiles/${id}`); }
  requestProfile(r: { service: string; instance?: string; kind: 'cpu' | 'alloc'; seconds: number }) { return this.http.post<ProfileInfo>('/api/profiles', r); }
  revokeApiKey(id: string) { return this.http.post(`/api/admin/keys/${id}/revoke`, {}); }
  error(fp: string, r: Range) { return this.get<ErrorDetail>(`/api/errors/${fp}`, { ...r }); }
  metrics(r: Range, service: string) { return this.get<MetricInfo[]>('/api/metrics', { ...r, service }); }
  metricKeys(r: Range, name: string) { return this.get<string[]>('/api/metrics/keys', { ...r, name }); }
  metricExemplars(r: Range, name: string, service: string) {
    return this.get<ExemplarItem[]>('/api/metrics/exemplars', { ...r, name, service, limit: 20 });
  }
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
  serviceMap(r: Range) { return this.get<ServiceMap>('/api/service-map', { ...r }); }
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
