/**
 * Palette « Entreprise » : calculée depuis la couleur de l'entreprise, dans les variables des palettes de styles.scss 
 * teintes des fonds (--h1…--h4, saturation --s) et des accents (--ha, --ha2, --ha3, saturation --sa). Les luminosités
 * restent celles des thèmes ; la saturation des accents est réduite, thème par thème, juste assez pour que liens, icônes
 * et libellés des boutons gardent un contraste d'au moins 3:1 (WCAG AA : composants et grands textes).
 */

/** Identifiant de la palette : html[data-palette='brand']. */
export const BRAND_PALETTE = 'brand';

export type Theme = 'dark' | 'light';

export interface BrandPalette {
  /** Teintes (degrés) du fond et de ses halos ; --h1 teinte aussi le verre et les textes. */
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  /** Saturation des fonds (%). */
  s: number;
  /** Teintes des accents : celle de l'entreprise, puis ses deux voisines. */
  ha: number;
  ha2: number;
  ha3: number;
  /** Saturation des accents (%) : celle de la couleur, puis celle retenue dans chaque thème pour rester lisible. */
  sa: number;
  saDark: number;
  saLight: number;
}

/** Palette Océan (par défaut : :root de styles.scss), pour les aperçus sans couleur d'entreprise. */
export const OCEAN: BrandPalette = { h1: 217, h2: 195, h3: 182, h4: 232, s: 85, ha: 199, ha2: 217, ha3: 174, sa: 92, saDark: 92, saLight: 92 };

const MIN_CONTRAST = 3;

/**
 * Luminosités des thèmes (styles.scss) : fond (part de --s, luminosité), accents 1 à 3, texte posé sur un accent
 * (saturation, luminosité ; null : blanc).
 */
const THEMES = {
  dark: { bg: [0.55, 0.05], accents: [0.66, 0.64, 0.58], onAccent: [0.7, 0.07] },
  light: { bg: [0.7, 0.97], accents: [0.4, 0.46, 0.36], onAccent: null },
} as const;

/** #rgb ou #rrggbb (dièse facultatif) → #rrggbb en minuscules ; null si ce n'est pas une couleur. */
export function normalizeHex(value: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value ?? '').trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return '#' + hex.toLowerCase();
}

/** Teinte (degrés), saturation et luminosité (0 à 1) d'une couleur #rrggbb. */
export function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
}

/** Palette « Entreprise » d'une couleur (null si elle est absente ou invalide). */
export function brandPalette(color: string | null | undefined): BrandPalette | null {
  const hex = normalizeHex(color);
  if (!hex) return null;
  const [hue, sat] = hexToHsl(hex);
  const ha = wrap(hue);
  // Teintes voisines : jamais vers le violet ou le rose (un bleu au-delà de 235° vire déjà au violet une fois éclairci ;
  // pour les fonds d'une couleur chaude, pas vers le rouge, rose une fois éclairci), sauf pour une entreprise violette ou rose.
  const own = ha >= 262 && ha < 345;
  const red = ha >= 345 || ha < 15;
  const near = (offset: number, background: boolean) => {
    const h = wrap(ha + offset);
    const away = !own && ((h >= 235 && h < 345) || (background && !red && (h >= 345 || h < 15)));
    return away ? wrap(ha - offset) : h;
  };
  // Accent 2 (fin des dégradés, sous le libellé des boutons) du côté de la roue où la teinte est la plus sombre ; accent 3 de l'autre.
  const step = luminance(ha + 18, sat, 0.46) <= luminance(ha - 18, sat, 0.46) ? 18 : -18;
  const ha2 = near(step, false);
  const ha3 = near(-step * 1.4, false);
  // Fonds : teintes voisines (± 25°), saturation plafonnée, un peu moins vive pour les teintes chaudes (rouge → jaune).
  const s = Math.round(Math.min(sat, 0.8) * (ha < 70 || ha > 330 ? 0.85 : 1) * 100);
  const h1 = near(6, true);
  const sa = Math.round(Math.min(sat, 0.95) * 100);

  /** Saturation la plus forte (≤ sa) qui garde accents et libellés de boutons lisibles dans le thème. */
  const readable = (theme: Theme) => {
    const t = THEMES[theme];
    const bg = luminance(h1, (s / 100) * t.bg[0], t.bg[1]);
    const onAccent = t.onAccent ? luminance(h1, t.onAccent[0], t.onAccent[1]) : 1;
    for (let v = sa; v > 0; v--) {
      const [a1, a2, a3] = [ha, ha2, ha3].map((h, i) => luminance(h, v / 100, t.accents[i]));
      if (Math.min(contrast(a1, bg), contrast(a3, bg), contrast(a1, onAccent), contrast(a2, onAccent)) >= MIN_CONTRAST) return v;
    }
    return 0;
  };

  return { h1, h2: near(-14, true), h3: near(-25, true), h4: near(18, true), s, ha, ha2, ha3, sa, saDark: readable('dark'), saLight: readable('light') };
}

/**
 * Règles CSS de la palette (html[data-palette='brand']) ; la saturation des accents propre au thème clair suit les
 * sélecteurs de styles.scss (attribut data-theme, sinon réglage du système).
 */
export function paletteCss(p: BrandPalette): string {
  const root = `html[data-palette='${BRAND_PALETTE}']`;
  const css = `${root} { --h1: ${p.h1}; --h2: ${p.h2}; --h3: ${p.h3}; --h4: ${p.h4}; --s: ${p.s}%; `
    + `--ha: ${p.ha}; --ha2: ${p.ha2}; --ha3: ${p.ha3}; --sa: ${p.saDark}%; }`;
  if (p.saLight === p.saDark) return css;
  const light = `{ --sa: ${p.saLight}%; }`;
  return `${css}\n${root}[data-theme='light'] ${light}\n@media (prefers-color-scheme: light) { ${root}:not([data-theme='dark']) ${light} }`;
}

/** Variables de la palette pour un style en ligne (aperçus), dans un thème. */
export function paletteVars(p: BrandPalette, theme: Theme): Record<string, string> {
  return {
    '--h1': `${p.h1}`, '--h2': `${p.h2}`, '--h3': `${p.h3}`, '--h4': `${p.h4}`, '--s': `${p.s}%`,
    '--ha': `${p.ha}`, '--ha2': `${p.ha2}`, '--ha3': `${p.ha3}`, '--sa': `${theme === 'dark' ? p.saDark : p.saLight}%`,
  };
}

/** Les trois couleurs d'accent de la palette dans un thème (--accent, --accent-2, --accent-3). */
export function accentColors(p: BrandPalette, theme: Theme): string[] {
  const sa = theme === 'dark' ? p.saDark : p.saLight;
  return [p.ha, p.ha2, p.ha3].map((h, i) => `hsl(${h} ${sa}% ${Math.round(THEMES[theme].accents[i] * 100)}%)`);
}

/** Dégradé d'une pastille du sélecteur de couleurs : la couleur de l'entreprise, puis son accent voisin. */
export function swatchGradient(color: string, p: BrandPalette): string {
  return `linear-gradient(135deg, ${color} 30%, hsl(${p.ha2} ${p.saDark}% 52%))`;
}

/** Composantes RVB (0 à 1) d'une couleur HSL (teinte en degrés, saturation et luminosité de 0 à 1). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = wrap(h) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Luminance relative (WCAG) d'une couleur HSL. */
function luminance(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb(h, s, l).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Teinte ramenée entre 0 et 359, en degrés entiers (comme dans styles.scss). */
function wrap(h: number): number {
  return ((Math.round(h) % 360) + 360) % 360;
}
