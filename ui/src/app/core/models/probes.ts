/** Sondes de disponibilité. */
export interface Probe {
  id: string;
  name: string;
  enabled: boolean;
  type: 'http' | 'tcp' | 'email';
  target: string;
  method: string;
  intervalSeconds: number;
  /** Heures fixes (« HH:mm », heure de Wolflog) : remplacent l'intervalle. */
  scheduleTimes?: string[] | null;
  /** Jours des heures fixes (0 = dimanche … 6 = samedi) ; vide = tous les jours. */
  scheduleDays?: number[] | null;
  timeoutSeconds: number;
  expectedStatus: string;
  expectedText: string | null;
  failuresBeforeDown: number;
  service: string | null;
  ignoreTlsErrors: boolean;
  /** Sonde e-mail : envoi SMTP, réception IMAP facultative. */
  email?: EmailProbeSettings | null;
}

/** Sécurité de la connexion : auto (465 / 993 en TLS, sinon STARTTLS proposé), starttls exigé, ssl dès la connexion, aucune. */
export type MailSecurity = 'auto' | 'starttls' | 'ssl' | 'none';

/** Connexion OAuth à une messagerie Microsoft : compte connecté (code) ou application Entra ID. */
export interface MicrosoftMailAuth {
  mode: 'account' | 'app';
  tenant: string | null;
  clientId: string | null;
  /** Saisie seulement ; vide = secret enregistré conservé (même application). */
  clientSecret?: string | null;
  hasClientSecret?: boolean;
  /** Compte connecté (adresse). */
  account?: string | null;
  /** Saisie seulement : connexion qui vient d'aboutir. */
  connectionId?: string | null;
  connected?: boolean;
}

/** Réglages déduits d'une adresse (DNS du domaine). */
export interface DetectedMailSettings {
  provider: string;
  label: string;
  smtp: { host: string; port: number; security: MailSecurity } | null;
  imap: { host: string; port: number; security: MailSecurity } | null;
  /** password, app-password (mot de passe d'application) ou microsoft (OAuth). */
  auth: 'password' | 'app-password' | 'microsoft';
  evidence: string | null;
  notes: string[];
}

export interface DeviceConnection {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceConnectionStatus {
  status: 'pending' | 'ok' | 'error';
  account: string | null;
  error: string | null;
}

export interface EmailProbeSettings {
  /** password (identifiant et mot de passe) ou microsoft (OAuth). */
  auth?: 'password' | 'microsoft';
  microsoft?: MicrosoftMailAuth | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  smtpUser: string | null;
  /** Saisie seulement (jamais renvoyé) ; vide = mot de passe enregistré conservé. */
  smtpPassword?: string | null;
  hasSmtpPassword?: boolean;
  from: string;
  to: string;
  imapHost: string | null;
  imapPort: number;
  imapSecurity: MailSecurity;
  imapUser: string | null;
  imapPassword?: string | null;
  hasImapPassword?: boolean;
  folder: string;
  deliveryTimeoutSeconds: number;
  spamIsFailure: boolean;
}

/** Étape d'une vérification (connexion, authentification, envoi, réception…). */
export interface ProbeStep {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string | null;
}

export interface ProbeResult {
  at: string;
  ok: boolean;
  durationMs: number;
  status: number | null;
  error: string | null;
  certificateDays: number | null;
  steps?: ProbeStep[] | null;
  /** Problème non bloquant (message arrivé dans les indésirables, accepté par réglage). */
  warning?: string | null;
}

export interface ProbeInfo {
  probe: Probe;
  status: 'up' | 'down' | 'unknown' | 'paused';
  since: string | null;
  last: ProbeResult | null;
  recent: ProbeResult[] | null;
  stats: { checks: number; uptime: number | null; avgMs: number | null; p95Ms: number | null; buckets: (number | null)[] } | null;
  /** Prochaine vérification prévue. */
  nextRun?: string | null;
}

/** Heure de Wolflog (plages d'activité, heures fixes). */
export interface ServerClock {
  zone: string;
  name: string;
  offsetMinutes: number;
  local: string;
}
