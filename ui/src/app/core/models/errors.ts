/** Groupes d'erreurs, occurrences et statuts. */
import type { Histogram, LogItem } from './logs';

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
