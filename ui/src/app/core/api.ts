import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { rememberEnvironments } from './environments';
import type { EnvironmentAdmin, EnvironmentProposal, EnvironmentSettings } from './models';
import { AccessProfile,ActiveAlert, AnalyticsBreakdownRow, AnalyticsComparison, AnalyticsDimension, AnalyticsEventProperty, AnalyticsFunnel, AnalyticsFunnelStep, AnalyticsRealtime, AnalyticsSeries, ClickmapFrustration, ClickmapPage, ClickmapReport, ClickmapSnapshot, AlertChannel, AlertEvaluation, AlertEventItem, AlertRule, AlertRuleInfo, ApiKeyInfo, BrandingInfo, BrandingInput, BrandingSettings, CustomQueryParams, CustomResult, Dashboard, DashboardAudience, DashboardInfo, DataSource, Deployment, EnvironmentInfo, ErrorDetail, ErrorList, ErrorState, ExemplarItem, FieldInfo, FieldValue, HealthReport, Histogram, HttpQuery, HttpRequestItem, HttpSummary, Integration, LdapAccountReport, LdapProbeReport, LogPage, LogSourceConfig, Me, MessageInput, MessagePreviewResult, MetricData, MetricInfo, NotificationSettings, Overview, Person, Probe, ProbeInfo, ProbeResult, ProfileInfo, ProfilingInstance, Range, Role, SavedSearch, SearchPage, ServiceInfo, ServiceMap, Slo, SloDetail, SloStatus, SourceInfo, SourcePreview, SsoAdmin, SsoSettingsInput, SsoTestReport, SystemStats, TraceDetail, TraceSummary, UserAccount } from './models';

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
  /**
   * profileId : profil d'accès (« all » ou vide : tout voir). services : liste propre au compte ([] = tous) ;
   * inheritServices : revenir aux services du profil.
   */
  createUser(u: { username: string; displayName?: string; email?: string; role: Role; profileId?: string | null; services?: string[] | null }) {
    return this.http.post<{ user: UserAccount; temporaryPassword: string }>('/api/admin/users', u);
  }
  updateUser(id: string, u: Partial<{ displayName: string; email: string; role: Role; disabled: boolean; profileId: string; services: string[]; inheritServices: boolean }>) {
    return this.http.put<UserAccount>(`/api/admin/users/${id}`, u);
  }
  resetPassword(id: string) { return this.http.post<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`, {}); }
  deleteUser(id: string) { return this.http.delete(`/api/admin/users/${id}`); }

  // Profils d'accès : parties de Wolflog visibles par profil (administration).
  accessProfiles() { return this.get<AccessProfile[]>('/api/admin/access-profiles'); }
  saveAccessProfile(p: AccessProfile) {
    return p.id ? this.http.put<AccessProfile>(`/api/admin/access-profiles/${p.id}`, p) : this.http.post<AccessProfile>('/api/admin/access-profiles', p);
  }
  deleteAccessProfile(id: string) { return this.http.delete(`/api/admin/access-profiles/${id}`); }

  // Connexion unique : Microsoft Entra ID, Windows, annuaire LDAP et création des comptes (administration).
  ssoSettings() { return this.get<SsoAdmin>('/api/admin/sso'); }
  saveSsoSettings(s: SsoSettingsInput) { return this.http.put<SsoAdmin>('/api/admin/sso', s); }
  /** Vérifie le locataire, l'application et le secret (vide : celui enregistré), sans rien enregistrer. */
  testSso(t: { tenant: string; clientId: string; clientSecret: string }) { return this.http.post<SsoTestReport>('/api/admin/sso/test', t); }
  /** Annuaire LDAP : connexion, chiffrement, compte de service et DN de base, avec les réglages en cours de saisie. */
  testLdap(settings: SsoSettingsInput) { return this.http.post<LdapProbeReport>('/api/admin/sso/ldap/test', { settings }); }
  /** Annuaire LDAP : compte d'une personne et ce que Wolflog lui donnerait, sans le créer. */
  testLdapAccount(settings: SsoSettingsInput, username: string, password: string) {
    return this.http.post<LdapAccountReport>('/api/admin/sso/ldap/account', { settings, username, password });
  }

  apiKeys() { return this.get<{ configKeys: number; keys: ApiKeyInfo[] }>('/api/admin/keys'); }
  createApiKey(k: { name: string; kind: 'server' | 'browser' | 'read'; origins?: string[] }) {
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
  saveMessageTemplates(title: string | null, body: string | null) { return this.http.put('/api/notification-settings/templates', { title, body }); }
  messagePreview(input: MessageInput) { return this.http.post<MessagePreviewResult>('/api/alerts/message/preview', input); }
  messageTest(input: MessageInput) { return this.http.post<{ sent: string[] }>('/api/alerts/message/test', input); }
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
  /** Noms des environnements (valeurs de ?env=), dans l'ordre du sélecteur ; service : ceux de cette application, sans ceux qu'elle masque. */
  environments(service?: string | null) { return this.get<string[]>('/api/environments', { service }); }
  /** Environnements avec libellé, couleur, valeurs regroupées et activité sur 7 jours ; retenus pour les couleurs et libellés de toute l'interface. */
  environmentStats(service?: string | null) {
    return this.get<EnvironmentInfo[]>('/api/environments/stats', { service }).pipe(tap((list) => rememberEnvironments(list, !service)));
  }
  dashboards() { return this.get<DashboardInfo[]>('/api/dashboards'); }
  dashboard(id: string) { return this.get<Dashboard>(`/api/dashboards/${id}`); }
  createDashboard(d: Partial<Dashboard>) { return this.http.post<Dashboard>('/api/dashboards', d); }
  saveDashboard(d: Dashboard) { return this.http.put<Dashboard>(`/api/dashboards/${d.id}`, d); }
  deleteDashboard(id: string) { return this.http.delete(`/api/dashboards/${id}`); }
  /** Profils d'accès proposés dans « Visible pour » (noms seulement). */
  dashboardAudiences() { return this.get<DashboardAudience[]>('/api/dashboards/access-profiles'); }
  services(r: Range) { return this.get<ServiceInfo[]>('/api/services', { ...r }); }
  overview(r: Range) { return this.get<Overview>('/api/overview', { ...r }); }
  system() { return this.get<SystemStats>('/api/system'); }
  integration() { return this.get<Integration>('/api/system/integration'); }
  flush() { return this.http.post('/api/system/flush', {}); }
  compact() { return this.http.post('/api/system/compact', {}); }

  // ------------------------------------------------------------ personnalisation (lecture publique, modification : administrateurs)
  branding() { return this.get<BrandingInfo>('/api/branding'); }
  brandingSettings() { return this.get<BrandingSettings>('/api/admin/branding'); }
  saveBranding(b: BrandingInput) { return this.http.put<BrandingSettings>('/api/admin/branding', b); }
  uploadLogo(file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<BrandingSettings>('/api/admin/branding/logo', form);
  }
  deleteLogo() { return this.http.delete<BrandingSettings>('/api/admin/branding/logo'); }

  // ------------------------------------------------------------ environnements (administration)
  environmentSettings() { return this.get<EnvironmentAdmin>('/api/admin/environments'); }
  saveEnvironmentSettings(s: EnvironmentSettings) { return this.http.put<EnvironmentSettings>('/api/admin/environments', s); }
  /** « Regrouper automatiquement » : réglages en cours de saisie complétés d'après les valeurs reçues (rien n'est enregistré). */
  suggestEnvironments(s: EnvironmentSettings) { return this.http.post<EnvironmentProposal>('/api/admin/environments/suggest', s); }

  // ------------------------------------------------------------ audience web
  /** Filtres d'audience : service global + dimensions (f.page, f.country…). */
  private audience(r: Range, service: string, filters: Record<string, string>): Params {
    const p: Params = { ...r, service };
    for (const [k, v] of Object.entries(filters)) p['f.' + k] = v;
    return p;
  }
  analyticsSummary(r: Range, service: string, filters: Record<string, string>) {
    return this.get<AnalyticsComparison>('/api/analytics/summary', this.audience(r, service, filters));
  }
  analyticsSeries(r: Range, service: string, filters: Record<string, string>, compare: boolean) {
    return this.get<AnalyticsSeries>('/api/analytics/series', { ...this.audience(r, service, filters), compare });
  }
  analyticsBreakdown(r: Range, service: string, filters: Record<string, string>, dimension: AnalyticsDimension, limit = 10) {
    return this.get<AnalyticsBreakdownRow[]>('/api/analytics/breakdown', { ...this.audience(r, service, filters), dimension, limit });
  }
  analyticsEventProperties(r: Range, service: string, filters: Record<string, string>, name: string) {
    return this.get<AnalyticsEventProperty[]>(`/api/analytics/events/${encodeURIComponent(name)}/properties`, this.audience(r, service, filters));
  }
  analyticsRealtime(service: string) { return this.get<AnalyticsRealtime>('/api/analytics/realtime', { service }); }
  analyticsFunnel(r: Range, service: string, filters: Record<string, string>, steps: AnalyticsFunnelStep[], window: number) {
    return this.get<AnalyticsFunnel>('/api/analytics/funnel', { ...this.audience(r, service, filters), steps: JSON.stringify(steps), window });
  }
  clickmapPages(r: Range, service: string, device: string) {
    return this.get<ClickmapPage[]>('/api/analytics/clickmaps', { ...r, service, device });
  }
  clickmap(r: Range, service: string, path: string, device: string) {
    return this.get<ClickmapReport>('/api/analytics/clickmap', { ...r, service, path, device });
  }
  clickmapFrustrations(r: Range, service: string, device: string) {
    return this.get<ClickmapFrustration[]>('/api/analytics/frustrations', { ...r, service, device });
  }
  /** Capture de la page (texte du contenu masqué) : décor de la carte quand la page en direct n'est pas affichable dans Wolflog. */
  clickmapSnapshot(service: string, path: string, device: string) {
    return this.get<ClickmapSnapshot>('/api/analytics/clickmap/snapshot', { service, path, device });
  }
  /** Jeton de la carte affichée sur le site lui-même (« Ouvrir sur le site »), pour le service, l'environnement et la période en cours. */
  clickmapViewer(r: Range, service: string) {
    return this.http.post<{ token: string; expiresAt: string }>('/api/analytics/clickmap/viewer', {}, { params: this.params({ ...r, service }) });
  }
}
