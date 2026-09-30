/** Libellés de l'audience web : noms des dimensions et des valeurs (pays, langues, appareils…). */
import { AnalyticsDimension } from './models';

export const DIMENSION_NAMES: Record<AnalyticsDimension, string> = {
  page: 'Page', entry: "Page d'entrée", exit: 'Page de sortie', title: 'Titre', host: 'Domaine', referrer: 'Référent',
  browser: 'Navigateur', os: 'Système', device: 'Appareil', country: 'Pays', language: 'Langue', screen: 'Écran',
  event: 'Événement', source: 'Collecte', utm_source: 'Source UTM', utm_medium: 'Support UTM', utm_campaign: 'Campagne UTM',
};

const DEVICES: Record<string, string> = { desktop: 'Ordinateur', mobile: 'Mobile', tablet: 'Tablette' };
const SOURCES: Record<string, string> = { browser: 'Script navigateur', server: 'Application (serveur)' };

let regions: Intl.DisplayNames | null = null;
let languages: Intl.DisplayNames | null = null;

export function countryName(code: string): string {
  try {
    regions ??= new Intl.DisplayNames(['fr'], { type: 'region' });
    return regions.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function languageName(code: string): string {
  try {
    languages ??= new Intl.DisplayNames(['fr'], { type: 'language' });
    const name = languages.of(code) ?? code;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return code;
  }
}

/** Valeur lisible d'une dimension ; null = « (direct) » pour les référents, « (inconnu) » sinon. */
export function dimensionValue(dimension: string, value: string | null): string {
  if (value === null || value === '') return dimension === 'referrer' ? '(direct)' : '(inconnu)';
  switch (dimension) {
    case 'country': return countryName(value);
    case 'language': return languageName(value);
    case 'device': return DEVICES[value] ?? value;
    case 'source': return SOURCES[value] ?? value;
    default: return value;
  }
}
