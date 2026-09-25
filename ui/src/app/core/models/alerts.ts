/** Règles, états, historique et canaux des alertes. */
import type { DataSource } from './dashboards';

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
