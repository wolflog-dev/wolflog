/** Environnements configurés (Administration › Environnements) : regroupement des valeurs envoyées par les applications. */

/** Type d'un environnement, qui donne sa couleur : production (rouge), recette ou préproduction (ambre), développement (vert), autre. */
export type EnvironmentKind = 'production' | 'recette' | 'developpement' | 'autre';

/** Environnement configuré : son nom (valeur de ?env=) regroupe son nom et ses alias, sans tenir compte de la casse. */
export interface EnvironmentDefinition {
  /** Identifiant stable en minuscules (liens, alertes) ; non modifiable une fois enregistré. */
  name: string;
  label: string;
  kind: EnvironmentKind;
  /** Couleur personnalisée (#rrggbb), prioritaire sur celle du type. */
  color: string | null;
  order: number;
  /** Absent du sélecteur de la barre du haut (données toujours accessibles). */
  hidden: boolean;
  /** Valeurs envoyées par les applications regroupées sous ce nom. */
  aliases: string[];
}

/** Réglages propres à une application : ses alias priment pour elle seule. */
export interface AppEnvironments {
  service: string;
  /** Valeur envoyée → nom de l'environnement ; '' : valeur gardée telle quelle. */
  aliases: Record<string, string>;
  /** Environnements (noms ou valeurs non regroupées) masqués quand l'application est choisie. */
  hidden: string[];
}

export interface EnvironmentSettings {
  environments: EnvironmentDefinition[];
  apps: AppEnvironments[];
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** Valeur d'environnement reçue d'une application (30 derniers jours). */
export interface EnvironmentUsage {
  service: string;
  env: string;
  logs: number;
  errors: number;
  spans: number;
  lastSeen: string | null;
}

/** Page d'administration : réglages enregistrés et valeurs reçues de chaque application. */
export interface EnvironmentAdmin extends EnvironmentSettings {
  seen: EnvironmentUsage[];
}

/** « Regrouper automatiquement » : réglages complétés (non enregistrés). */
export interface EnvironmentProposal extends EnvironmentSettings {
  grouped: number;
  created: number;
}
