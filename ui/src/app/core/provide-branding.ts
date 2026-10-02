import { EnvironmentProviders, inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { TitleStrategy } from '@angular/router';
import { BrandTitleStrategy } from './brand-title-strategy';
import { Branding } from './branding';

/**
 * Personnalisation de l'entreprise : chargée au démarrage (une seconde d'attente au plus, jamais bloquante en cas
 * d'erreur) et reprise dans les titres des pages.
 */
export function provideBranding(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => inject(Branding).load()),
    { provide: TitleStrategy, useClass: BrandTitleStrategy },
  ]);
}
