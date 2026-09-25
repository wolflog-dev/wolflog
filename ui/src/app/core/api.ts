import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ActiveAlert, AlertChannel, AlertEvaluation, AlertEventItem, AlertRule, AlertRuleInfo, ApiKeyInfo, CustomQueryParams, CustomResult, Dashboard, DashboardInfo, DataSource, Deployment, ErrorDetail, ErrorList, ErrorState, ExemplarItem, FieldInfo, FieldValue, HealthReport, Histogram, HttpQuery, HttpRequestItem, HttpSummary, Integration, LogPage, LogSourceConfig, Me, MetricData, MetricInfo, NotificationSettings, Overview, Person, Probe, ProbeInfo, ProbeResult, ProfileInfo, ProfilingInstance, Range, Role, SavedSearch, SearchPage, ServiceInfo, ServiceMap, Slo, SloDetail, SloStatus, SourceInfo, SourcePreview, SystemStats, TraceDetail, TraceSummary, UserAccount } from './models';

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
  wolflogHealth() { return this.get<HealthReport>('/api/health/wolflog'); }
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
