/** Audience web (visiteurs anonymes, utilisateurs identifiés, pages vues, sources, événements) et cartes de chaleur. */
export interface AnalyticsSummary {
  visitors: number;
  visits: number;
  pageviews: number;
  events: number;
  bounces: number;
  totalSeconds: number;
  revenue: number;
  /** Utilisateurs identifiés par l'application (pseudonymes distincts). */
  users: number;
  /** Utilisateurs vus pour la première fois sur la période. */
  newUsers: number;
  bounceRate: number;
  avgVisitSeconds: number;
}

export interface AnalyticsComparison {
  current: AnalyticsSummary;
  previous: AnalyticsSummary;
}

export interface AnalyticsSeries {
  step: number;
  times: string[];
  visitors: number[];
  users: number[];
  pageviews: number[];
  previousVisitors: number[] | null;
}

export interface AnalyticsBreakdownRow {
  value: string | null;
  visitors: number;
  count: number;
  users: number;
}

export interface AnalyticsLiveEvent {
  ts: string;
  kind: number;
  service: string;
  path: string;
  eventName: string | null;
  referrer: string | null;
  country: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  visitor: string;
  /** Début du pseudonyme de l'utilisateur connecté, sinon null (visiteur anonyme). */
  user: string | null;
}

export interface AnalyticsRealtime {
  active: number;
  visitors: number;
  /** Utilisateurs connectés actifs (5 min) et sur les 30 dernières minutes. */
  activeUsers: number;
  users: number;
  perMinute: number[];
  recent: AnalyticsLiveEvent[];
  pages: AnalyticsBreakdownRow[];
  referrers: AnalyticsBreakdownRow[];
  countries: AnalyticsBreakdownRow[];
}

export interface AnalyticsEventProperty {
  key: string;
  value: string | null;
  count: number;
}

export interface AnalyticsFunnelStep {
  type: 'url' | 'event';
  value: string;
}

export interface AnalyticsFunnel {
  steps: AnalyticsFunnelStep[];
  counts: number[];
}

/** Dimension de ventilation ou de filtre de l'audience. */
export type AnalyticsDimension =
  | 'page' | 'entry' | 'exit' | 'title' | 'host' | 'referrer' | 'browser' | 'os' | 'device' | 'country' | 'language'
  | 'screen' | 'event' | 'source' | 'utm_source' | 'utm_medium' | 'utm_campaign';

export interface ClickmapPage {
  path: string;
  clicks: number;
  views: number;
  rage: number;
  dead: number;
}

export interface ClickmapElement {
  selector: string | null;
  label: string | null;
  clicks: number;
  rage: number;
  dead: number;
}

export interface ClickmapReport {
  /** Hôte le plus fréquent de la page (avec le port), pour l'aperçu. */
  host: string | null;
  width: number;
  height: number;
  fold: number;
  clicks: number;
  views: number;
  rage: number;
  dead: number;
  avgScroll: number;
  points: { x: number; y: number; count: number }[];
  elements: ClickmapElement[];
  scroll: { depth: number; share: number }[];
}

/** Capture de la page faite par le navigateur d'un visiteur (texte du contenu masqué), décor de la carte. */
export interface ClickmapSnapshot {
  service: string;
  device: string;
  capturedAt: string;
  width: number;
  height: number;
  html: string;
}

export interface ClickmapFrustration {
  path: string;
  selector: string | null;
  label: string | null;
  rage: number;
  dead: number;
}
