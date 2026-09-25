/** Profilage à la demande. */
export interface ProfilingInstance {
  service: string;
  instance: string;
  host: string | null;
  version: string | null;
  runtime: string | null;
  lastSeen: string;
}

export interface ProfileInfo {
  id: string;
  service: string;
  instance: string;
  host: string | null;
  version: string | null;
  kind: 'cpu' | 'alloc';
  start: string;
  seconds: number;
  samples: number;
  total: number;
  error: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  requestedBy: string | null;
  requestedAt: string;
}
