/** Services, vue d'ensemble, état du serveur et santé. */
import type { EnvironmentKind } from './environments';
import type { ErrorGroup } from './errors';
import type { Histogram } from './logs';

/**
 * Environnement vu sur les 7 derniers jours, avec son activité : environnement configuré (valeurs reçues regroupées,
 * application par application) ou valeur reçue telle quelle. Liste déjà triée (order) et sans les environnements masqués.
 */
export interface EnvironmentInfo {
  /** Valeur de ?env= (nom de l'environnement configuré, ou valeur reçue). */
  name: string;
  /** Libellé affiché (la valeur reçue si l'environnement n'est pas configuré). */
  label: string;
  kind: EnvironmentKind;
  /** Teinte du thème : danger, warn, ok ou accent. */
  tone: string;
  /** Couleur personnalisée (#rrggbb), prioritaire sur la teinte. */
  color: string | null;
  order: number;
  /** Environnement configuré (Administration › Environnements). */
  configured: boolean;
  /** Valeurs reçues regroupées sous cet environnement. */
  raw: string[];
  /** Applications qui y ont envoyé des données, et les valeurs reçues de chacune. */
  apps: { service: string; raw: string[] }[];
  logs: number;
  errors: number;
  spans: number;
  /** Nombre d'applications. */
  services: number;
  lastSeen: string | null;
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

export interface HealthReport {
  status: 'ok' | 'warning' | 'critical';
  checks: { id: string; name: string; status: 'ok' | 'warning' | 'critical'; message: string; value: number | null }[];
  at: string;
}
