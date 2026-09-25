/** Sources de logs lues par Wolflog. */
import type { Level } from './logs';

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
