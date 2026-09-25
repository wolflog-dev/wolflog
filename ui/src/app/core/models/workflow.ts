/** Personnes, déploiements et recherches enregistrées. */
export interface Person {
  username: string;
  displayName: string;
}

export interface Deployment {
  id: string;
  service: string;
  env: string | null;
  version: string;
  at: string;
  source: 'auto' | 'initial' | 'api';
  description: string | null;
  by: string | null;
}

export type SearchPage = 'logs' | 'requests' | 'traces' | 'errors';

export interface SavedSearch {
  id: string;
  name: string;
  page: SearchPage;
  params: Record<string, string>;
  owner: string | null;
  shared: boolean;
  mine: boolean;
}
