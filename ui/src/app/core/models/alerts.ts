/** Règles, états, historique et canaux des alertes. */
import type { DataSource } from './dashboards';
import type { MicrosoftMailAuth } from './probes';

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
  /** HTTP : errorRate, percent, count, rate, p50… ; sonde : down, duration, availability, certificate ; erreur : new, frequent. */
  stat?: string | null;
  /** HTTP : requêtes concernées (syntaxe de recherche des requêtes). */
  route?: string | null;
  /** HTTP : condition sur la réponse (ex. status:4xx). */
  match?: string | null;
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
  /** Modèles de notification propres à la règle (null : modèle par défaut). */
  titleTemplate?: string | null;
  bodyTemplate?: string | null;
  mutedUntil?: string | null;
  createdBy?: string | null;
  /** Plage d'activité (heure de Wolflog) : jours (0 = dimanche), début et fin « HH:mm ». */
  activeDays?: number[] | null;
  activeFrom?: string | null;
  activeTo?: string | null;
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
  smtpAuth?: 'password' | 'microsoft';
  microsoft?: MicrosoftMailAuth | null;
  titleTemplate?: string | null;
  bodyTemplate?: string | null;
}

/** Variable insérable dans un modèle de message, avec sa valeur dans l'aperçu. */
export interface MessageVariable {
  name: string;
  label: string;
  description: string;
  value: string | null;
}

/** Notification rendue par le serveur (mêmes règles que l'envoi réel). */
export interface MessagePreview {
  title: string;
  html: string;
  slack: string;
  text: string;
  link: string | null;
  tone: 'Good' | 'Warning' | 'Attention';
}

export interface MessagePreviewResult {
  preview: MessagePreview;
  /** true : aucune donnée réelle pour la règle, valeurs d'exemple. */
  sample: boolean;
  titleTemplate: string;
  bodyTemplate: string;
  variables: MessageVariable[];
}

export interface MessageInput {
  rule: AlertRule | null;
  title: string | null;
  body: string | null;
  channels?: string[] | null;
  /** Aperçu seulement : état du message (déclenchement par défaut). */
  status?: 'firing' | 'resolved' | 'test';
}
