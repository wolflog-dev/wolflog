import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { BRAND_PALETTE, brandPalette, paletteCss, swatchGradient } from './brand-palette';
import { BrandingInfo } from './models';
import { readSetting } from './settings';

/** Cache relu par le script de index.html avant le démarrage : la palette ne passe jamais par les couleurs par défaut. */
const CSS_KEY = 'wolflog.brand.css';
const FORCE_KEY = 'wolflog.brand.force';
const STYLE_ID = 'brand-palette';

/**
 * Personnalisation aux couleurs de l'entreprise (page Personnalisation) : nom, logo, couleur, message d'accueil.
 * Chargée au démarrage (provideBranding) et appliquée à toute l'interface : palette « Entreprise »
 * (html[data-palette='brand'], règles dans <style id="brand-palette">), icône de l'onglet, titres des pages.
 */
@Injectable({ providedIn: 'root' })
export class Branding {
  private readonly api = inject(Api);
  /** Nom de l'entreprise (null : Wolflog). */
  readonly name = signal<string | null>(null);
  /** Adresse du logo (null : logo de Wolflog). */
  readonly logoUrl = signal<string | null>(null);
  /** Couleur de l'entreprise (#rrggbb ; null : palettes intégrées seulement). */
  readonly color = signal<string | null>(null);
  readonly loginMessage = signal<string | null>(null);
  /** Palette de l'entreprise imposée à tous : pas de choix de palette dans le menu. */
  readonly forcePalette = signal(false);

  /** Nom affiché à la place de « Wolflog » (titres des pages, menu). */
  readonly title = computed(() => this.name() ?? 'Wolflog');
  /** Nom ou logo de l'entreprise renseigné. */
  readonly branded = computed(() => !!(this.name() || this.logoUrl()));
  /** Palette « Entreprise » tirée de la couleur (null sans couleur). */
  readonly palette = computed(() => brandPalette(this.color()));
  /** Dégradé de la pastille « Entreprise » du sélecteur de couleurs (null sans couleur d'entreprise). */
  readonly swatch = computed(() => {
    const palette = this.palette();
    return palette ? swatchGradient(this.color()!, palette) : null;
  });

  /** Icône d'origine de l'onglet (index.html), remise quand le logo est retiré. */
  private defaultIcon: { href: string; type: string | null } | null = null;

  /**
   * Chargement au démarrage : attend la réponse une seconde au plus et ne lève jamais d'erreur
   * (la palette en cache est déjà appliquée par index.html ; une réponse tardive s'applique à son arrivée).
   */
  load(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.api.branding().subscribe({
        next: (b) => {
          this.apply(b);
          done();
        },
        error: done,
      });
    });
  }

  /** Applique une personnalisation (au démarrage, ou enregistrée depuis la page Personnalisation). */
  apply(b: BrandingInfo) {
    this.name.set(b.name?.trim() || null);
    this.logoUrl.set(b.hasLogo ? b.logoUrl : null);
    this.color.set(b.color);
    this.loginMessage.set(b.loginMessage?.trim() || null);
    this.forcePalette.set(b.forcePalette && !!b.color);
    this.applyPalette();
    this.applyIcon();
  }

  /**
   * Règles de la palette dans <style id="brand-palette"> (et en cache), puis palette de la page : celle de l'entreprise
   * si elle est imposée, sinon celle choisie dans le menu, à défaut celle de l'entreprise  même règle que index.html.
   */
  private applyPalette() {
    const palette = this.palette();
    const css = palette ? paletteCss(palette) : null;
    let style = document.getElementById(STYLE_ID);
    if (css) {
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.append(style);
      }
      if (style.textContent !== css) style.textContent = css;
    } else {
      style?.remove();
    }
    remember(CSS_KEY, css);
    remember(FORCE_KEY, css && this.forcePalette() ? '1' : null);

    const chosen = readSetting('wolflog.palette', '');
    const id = css ? (this.forcePalette() ? BRAND_PALETTE : chosen || BRAND_PALETTE) : chosen === BRAND_PALETTE ? '' : chosen;
    const root = document.documentElement;
    if (id) root.setAttribute('data-palette', id);
    else root.removeAttribute('data-palette');
  }

  /** Icône de l'onglet : le logo de l'entreprise s'il y en a un, sinon celle de Wolflog. */
  private applyIcon() {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) return;
    this.defaultIcon ??= { href: link.getAttribute('href') ?? 'favicon.svg', type: link.getAttribute('type') };
    const logo = this.logoUrl();
    const href = logo ?? this.defaultIcon.href;
    if (link.getAttribute('href') === href) return;
    link.setAttribute('href', href);
    // Type du logo inconnu ici (PNG, SVG…) : le navigateur le lit dans la réponse.
    if (!logo && this.defaultIcon.type) link.setAttribute('type', this.defaultIcon.type);
    else link.removeAttribute('type');
  }
}

/** Valeur gardée pour le prochain chargement (null : effacée) ; ignorée si le stockage est indisponible. */
function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}
