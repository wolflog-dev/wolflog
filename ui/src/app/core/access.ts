import { DataSource } from './models';

/**
 * Profils d'accès : parties de Wolflog qu'une personne peut voir (son rôle dit ce qu'elle peut y faire).
 * Mêmes identifiants que le serveur (Security/AccessSections.cs), qui contrôle chaque appel de l'API.
 */
export type SectionId =
  | 'overview' | 'dashboards' | 'logs' | 'requests' | 'traces' | 'errors' | 'metrics' | 'map' | 'profiles'
  | 'audience' | 'clickmaps' | 'alerts' | 'uptime' | 'slos';

/** Familles de parties (regroupement de l'éditeur de profils et de l'aperçu de la navigation). */
export type SectionCategory = 'Observer' | 'Explorer' | 'Web' | 'Surveiller';

export interface SectionInfo {
  id: SectionId;
  label: string;
  /** Icône de la navigation (core/icons.ts). */
  icon: string;
  /** Page ouverte par la navigation. */
  path: string;
  /** Préfixes des adresses qui en relèvent (« / » : la racine seule). */
  routes: string[];
  /** Ce qu'on y trouve, en quelques mots. */
  desc: string;
  category: SectionCategory;
}

export const SECTION_CATEGORIES: { id: SectionCategory; hint: string }[] = [
  { id: 'Observer', hint: 'Synthèse et tableaux de bord' },
  { id: 'Explorer', hint: 'Données techniques des applications' },
  { id: 'Web', hint: 'Visiteurs des sites' },
  { id: 'Surveiller', hint: 'Alertes, sondes et objectifs' },
];

/** Toutes les parties, dans l'ordre de la navigation. */
export const SECTIONS: SectionInfo[] = [
  { id: 'overview', label: "Vue d'ensemble", icon: 'overview', path: '/', routes: ['/'], category: 'Observer',
    desc: 'Santé des services, erreurs à traiter, alertes en cours' },
  { id: 'dashboards', label: 'Tableaux de bord', icon: 'dashboards', path: '/dashboards', routes: ['/dashboards'], category: 'Observer',
    desc: 'Courbes et chiffres clés rassemblés par thème' },
  { id: 'logs', label: 'Logs', icon: 'logs', path: '/logs', routes: ['/logs'], category: 'Explorer',
    desc: 'Messages des applications, recherche, flux en direct' },
  { id: 'requests', label: 'Requêtes HTTP', icon: 'requests', path: '/requests', routes: ['/requests'], category: 'Explorer',
    desc: 'Appels reçus et émis : statuts, latences, contenus' },
  { id: 'traces', label: 'Traces', icon: 'traces', path: '/traces', routes: ['/traces'], category: 'Explorer',
    desc: 'Parcours d’une requête d’un service à l’autre' },
  { id: 'errors', label: 'Erreurs', icon: 'errors', path: '/errors', routes: ['/errors'], category: 'Explorer',
    desc: 'Exceptions et crashs regroupés, suivi de leur traitement' },
  { id: 'metrics', label: 'Métriques', icon: 'metrics', path: '/metrics', routes: ['/metrics'], category: 'Explorer',
    desc: 'Mesures des applications et du runtime .NET' },
  { id: 'map', label: 'Carte des services', icon: 'map', path: '/map', routes: ['/map'], category: 'Explorer',
    desc: 'Qui appelle qui, avec débit et erreurs' },
  { id: 'profiles', label: 'Profils', icon: 'profiles', path: '/profiles', routes: ['/profiles'], category: 'Explorer',
    desc: 'Profilage CPU et mémoire à la demande' },
  { id: 'audience', label: 'Audience', icon: 'audience', path: '/audience', routes: ['/audience'], category: 'Web',
    desc: 'Visiteurs connectés, pages vues, sources, parcours' },
  { id: 'clickmaps', label: 'Clics & défilement', icon: 'clickmaps', path: '/clickmaps', routes: ['/clickmaps'], category: 'Web',
    desc: 'Cartes de chaleur des clics, profondeur de lecture' },
  { id: 'alerts', label: 'Alertes', icon: 'alerts', path: '/alerts', routes: ['/alerts'], category: 'Surveiller',
    desc: 'Règles, alertes en cours et historique' },
  { id: 'uptime', label: 'Disponibilité', icon: 'uptime', path: '/uptime', routes: ['/uptime'], category: 'Surveiller',
    desc: 'Sondes HTTP et TCP des sites et services' },
  { id: 'slos', label: 'Objectifs (SLO)', icon: 'slos', path: '/slos', routes: ['/slos'], category: 'Surveiller',
    desc: 'Objectifs de service et budget d’erreur' },
];

export const SECTION_IDS: SectionId[] = SECTIONS.map((s) => s.id);

const BY_ID = new Map<string, SectionInfo>(SECTIONS.map((s) => [s.id, s]));

export function sectionInfo(id: string | null | undefined): SectionInfo | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Partie dont relève une adresse de l'interface ; null : commune à toutes (mon compte, administration). */
export function sectionForUrl(url: string): SectionId | null {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  for (const s of SECTIONS) {
    for (const r of s.routes) {
      if (r === '/' ? path === '/' : path === r || path.startsWith(r + '/')) return s.id;
    }
  }
  return null;
}

/** « Tout voir » : toutes les parties, même celles des prochaines versions ; profil des comptes sans profil. */
export const EVERYTHING = 'all';

/** Icônes proposées pour un profil d'accès (la première : icône par défaut). */
export const PROFILE_ICONS = ['id-card', 'code', 'compass', 'server', 'headset', 'briefcase', 'megaphone', 'wrench', 'shield', 'chart-pie', 'users', 'terminal'];

/** Teinte d'un profil d'accès : fixe pour les profils fournis, stable (dérivée de l'identifiant) pour les autres. */
export function profileTone(id: string | null | undefined): string {
  const fixed: Record<string, string> = { all: 'var(--accent)', product: 'var(--accent-3)', ops: 'var(--ok)' };
  if (!id) return 'var(--accent)';
  if (fixed[id]) return fixed[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997;
  return ['var(--accent-2)', 'var(--accent-3)', 'var(--ok)', 'var(--accent)', 'var(--warn)'][h % 5];
}

/** Profil effectif d'un compte : sans profil, « Tout voir ». */
export function effectiveProfile(u: { profileId?: string | null }): string {
  return u.profileId || EVERYTHING;
}

/** Résumé d'un profil pour les listes : ses premières parties, ou « toutes ». */
export function profileSummary(p: { id: string; sections: string[] }): string {
  if (p.id === EVERYTHING) return 'Toutes les parties de Wolflog';
  const labels = SECTIONS.filter((s) => p.sections.includes(s.id)).map((s) => s.label);
  if (!labels.length) return 'Aucune partie';
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3}` : labels.join(', ');
}

/**
 * Le service correspond-il à l'un des noms ou motifs (« boutique-* ») ? Sans tenir compte de la casse, comme le serveur
 * (Security/ServiceScope.cs). Liste vide ou absente : tous les services.
 */
export function serviceMatches(patterns: readonly string[] | null | undefined, service: string): boolean {
  if (!patterns?.length) return true;
  return patterns.some((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(service));
}

/** Services visibles en clair : « Tous les services », ou les noms et motifs (les premiers, puis « +N »). */
export function servicesLabel(patterns: readonly string[] | null | undefined, max = 3): string {
  if (!patterns?.length) return 'Tous les services';
  return patterns.length > max ? `${patterns.slice(0, max).join(', ')} +${patterns.length - max}` : patterns.join(', ');
}

/** Parties qui ouvrent une source de requête personnalisée (l'une suffit) : même règle que le serveur (Api/ApiSections.cs). */
export function sourceSections(source: DataSource | null | undefined): SectionId[] {
  if (source === 'spans') return ['traces', 'requests'];
  if (source === 'metrics') return ['metrics'];
  return ['logs'];
}
