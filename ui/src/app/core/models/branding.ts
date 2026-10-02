/** Personnalisation aux couleurs de l'entreprise (page Personnalisation). */

/** Lecture publique (/api/branding) : la page de connexion l'affiche avant toute connexion. */
export interface BrandingInfo {
  /** Nom de l'entreprise, à la place de « Wolflog » (null : Wolflog). */
  name: string | null;
  /** Couleur de l'entreprise (#rrggbb) dont l'interface tire la palette « Entreprise ». */
  color: string | null;
  hasLogo: boolean;
  /** Adresse versionnée du logo (mise en cache sans limite) ; null sans logo. */
  logoUrl: string | null;
  loginMessage: string | null;
  /** Palette de l'entreprise imposée à tous (sinon proposée par défaut). */
  forcePalette: boolean;
}

/** Vue d'administration : en plus, le fichier du logo et la dernière modification. */
export interface BrandingSettings extends BrandingInfo {
  logoFileName: string | null;
  logoContentType: string | null;
  logoSize: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Champs enregistrés ensemble ; le logo s'envoie à part. */
export interface BrandingInput {
  name: string | null;
  color: string | null;
  loginMessage: string | null;
  forcePalette: boolean;
}
