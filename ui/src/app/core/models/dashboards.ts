/** Tableaux de bord, panneaux et requêtes personnalisées. */
export type PanelType = 'custom' | 'http' | 'metric' | 'logs' | 'logs-table' | 'errors' | 'stat';

export interface Panel {
  id: string;
  title: string;
  type: PanelType;
  width: number;
  height: 's' | 'm' | 'l';
  service?: string | null;
  query?: string | null;
  level?: string | null;
  metric?: string | null;
  stat?: string | null;
  groupBy?: string | null;
  statusClass?: string | null;
  outgoing?: boolean;
  source?: 'http' | 'logs' | 'errors' | null;
  // Requête personnalisée
  dataSource?: DataSource | null;
  aggregate?: string | null;
  field?: string | null;
  view?: CustomView | null;
  limit?: number | null;
}

export type DataSource = 'logs' | 'spans' | 'metrics';

export type CustomView = 'timeseries' | 'bars' | 'top' | 'table' | 'stat';

export interface CustomRow {
  group: string;
  value: number | null;
  count: number;
}

export interface CustomResult {
  view: CustomView;
  unit: string | null;
  stepSeconds: number;
  times: string[] | null;
  series: { name: string; group: string; values: (number | null)[] }[] | null;
  rows: CustomRow[] | null;
  value: number | null;
  count: number;
}

export interface FieldInfo {
  key: string;
  label: string;
  kind: 'text' | 'number';
  builtin: boolean;
  seen: number;
}

export interface FieldValue {
  value: string;
  count: number;
}

export interface CustomQueryParams {
  source: DataSource;
  filter?: string | null;
  agg: string;
  field?: string | null;
  groupBy?: string | null;
  view: CustomView;
  limit?: number | null;
  service?: string | null;
}

export interface DashboardVariable {
  name: string;
  label?: string | null;
  field: string;
  source: DataSource;
  default?: string | null;
}

export interface Dashboard {
  id: string;
  name: string;
  description?: string | null;
  panels: Panel[];
  variables?: DashboardVariable[];
  /** Profils d'accès qui voient ce tableau ; vide ou absent : tout le monde (les administrateurs voient tout). */
  visibleTo?: string[];
  updatedAt?: string;
  /** Panneaux retirés pour la personne connectée (hors de son profil d'accès), conservés à l'enregistrement. Réponse seulement. */
  hiddenPanels?: number | null;
}

export interface DashboardInfo {
  id: string;
  name: string;
  description: string | null;
  /** Panneaux utilisables par la personne connectée. */
  panels: number;
  /** Profils d'accès qui voient ce tableau ; vide : tout le monde. */
  visibleTo?: string[];
  updatedAt: string;
}

/** Profil d'accès proposé dans « Visible pour » d'un tableau de bord (nom seulement). */
export interface DashboardAudience {
  id: string;
  name: string;
  icon?: string | null;
}
