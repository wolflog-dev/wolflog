import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { AppState } from './app-state';
import { BRAND_PALETTE } from './brand-palette';
import { Branding } from './branding';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type NavChoice = 'auto' | 'on' | 'off';

/** Palettes de couleurs (html[data-palette], voir styles.scss) ; Océan par défaut. */
export const PALETTES = [
  { id: 'ocean', label: 'Océan', preview: 'linear-gradient(135deg, hsl(217 85% 56%), hsl(182 85% 44%))' },
  { id: 'emerald', label: 'Émeraude', preview: 'linear-gradient(135deg, hsl(162 72% 40%), hsl(199 72% 52%))' },
  { id: 'graphite', label: 'Graphite', preview: 'linear-gradient(135deg, hsl(220 14% 42%), hsl(212 85% 62%))' },
  { id: 'aurora', label: 'Aurore', preview: 'linear-gradient(135deg, hsl(265 80% 58%), hsl(330 80% 58%))' },
];

/**
 * Préférences d'affichage, propres à ce navigateur (localStorage) : thème, couleurs, animations, lueur qui suit le pointeur,
 * menu réduit. Appliquées sur <html> (data-theme, data-palette, data-motion), comme le script de démarrage d'index.html.
 */
@Injectable({ providedIn: 'root' })
export class Preferences {
  private readonly state = inject(AppState);
  private readonly branding = inject(Branding);
  private readonly root = document.documentElement;
  private readonly systemLight = matchMedia('(prefers-color-scheme: light)');

  /** Thème choisi ; « system » suit le réglage clair / sombre du système. */
  readonly theme = signal<ThemeChoice>(this.storedTheme());
  /** Thème réellement affiché. */
  readonly dark = signal(this.isDark());
  readonly palette = signal(this.root.getAttribute('data-palette') ?? 'ocean');
  /** Animations de l'interface (par défaut : réglage « Effets d'animation » du système). */
  readonly motion = signal(this.root.dataset['motion'] !== 'off');
  /** Lueur douce qui suit le pointeur, derrière le verre. */
  readonly glow = signal(read('wolflog.glow') !== 'off');
  /** Menu réduit aux icônes : automatique (selon la largeur), toujours, ou jamais. */
  readonly nav = signal<NavChoice>(this.storedNav());

  constructor() {
    this.systemLight.addEventListener('change', () => this.dark.set(this.isDark()));
    // La personnalisation applique elle-même sa palette (chargement tardif, enregistrement par un administrateur) : on suit.
    effect(() => {
      this.branding.palette();
      this.branding.forcePalette();
      untracked(() => this.palette.set(this.root.getAttribute('data-palette') ?? 'ocean'));
    });
  }

  setTheme(choice: ThemeChoice, origin?: { x: number; y: number }) {
    if (choice === this.theme()) return;
    this.swap(() => {
      if (choice === 'system') this.root.removeAttribute('data-theme');
      else this.root.setAttribute('data-theme', choice);
      write('wolflog.theme', choice === 'system' ? null : choice);
      this.theme.set(choice);
      this.dark.set(this.isDark());
    }, origin);
  }

  /** Bascule rapide clair / sombre (révélation circulaire depuis le point cliqué). */
  toggleTheme(origin?: { x: number; y: number }) {
    this.setTheme(this.dark() ? 'light' : 'dark', origin);
  }

  setPalette(id: string) {
    // Couleurs de l'entreprise imposées par l'administrateur : pas d'autre palette.
    if (id === this.palette() || (this.branding.forcePalette() && id !== BRAND_PALETTE)) return;
    this.swap(() => {
      this.root.setAttribute('data-palette', id);
      write('wolflog.palette', id);
      this.palette.set(id);
    });
  }

  /** Active ou coupe les animations ; le choix est mémorisé et prime sur le réglage du système. */
  setMotion(on: boolean) {
    this.root.setAttribute('data-motion', on ? 'on' : 'off');
    write('wolflog.motion', on ? 'on' : 'off');
    this.motion.set(on);
  }

  setGlow(on: boolean) {
    write('wolflog.glow', on ? null : 'off');
    this.glow.set(on);
  }

  setNav(choice: NavChoice) {
    write('wolflog.rail', choice === 'auto' ? null : choice);
    this.nav.set(choice);
  }

  private isDark() {
    const t = this.root.getAttribute('data-theme');
    return t ? t === 'dark' : !this.systemLight.matches;
  }

  private storedTheme(): ThemeChoice {
    const t = this.root.getAttribute('data-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  }

  private storedNav(): NavChoice {
    const n = read('wolflog.rail');
    return n === 'on' || n === 'off' ? n : 'auto';
  }

  /**
   * Applique un changement d'apparence avec View Transitions (si le navigateur les gère et que les animations sont
   * actives) : révélation circulaire depuis le point cliqué, sinon fondu. Les données sont ensuite redessinées.
   */
  private swap(apply: () => void, origin?: { x: number; y: number }) {
    if (!document.startViewTransition || !this.motion()) {
      apply();
      this.state.refresh();
      return;
    }
    const transition = document.startViewTransition(apply);
    transition.ready.then(() => {
      const pseudoElement = '::view-transition-new(root)';
      if (origin) {
        const radius = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y));
        this.root.animate({ clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
          { duration: 600, easing: 'cubic-bezier(.2, .8, .2, 1)', pseudoElement });
      } else {
        this.root.animate({ opacity: [0, 1] }, { duration: 450, easing: 'ease-out', pseudoElement });
      }
    });
    transition.finished.finally(() => this.state.refresh());
  }
}

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* stockage indisponible : réglage valable pour la session seulement */ }
}
