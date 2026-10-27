/** Sondes de disponibilité. */
export interface Probe {
  id: string;
  name: string;
  enabled: boolean;
  type: 'http' | 'tcp' | 'email';
  target: string;
  method: string;
  intervalSeconds: number;
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

export interface EmailProbeSettings {
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
}
