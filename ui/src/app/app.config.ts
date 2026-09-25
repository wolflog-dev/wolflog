import { ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding, withNavigationErrorHandler } from '@angular/router';
import { registerLocaleData } from '@angular/common';
import localeFr from '@angular/common/locales/fr';
import { routes } from './app.routes';
import { authInterceptor, envInterceptor } from './core/state';

registerLocaleData(localeFr);

/**
 * Vigil mis à jour pendant qu'un onglet était ouvert : les anciens fichiers de l'interface n'existent plus.
 * On recharge la page une fois pour obtenir la nouvelle version, au lieu d'une page blanche.
 */
function reloadOnStaleChunk(error: { error?: unknown }) {
  const message = String((error.error as Error | undefined)?.message ?? error.error ?? '');
  if (!/dynamically imported module|Loading chunk/i.test(message)) return;
  try {
    const last = Number(sessionStorage.getItem('vigil.reloaded') ?? 0);
    if (Date.now() - last < 30_000) return; // pas de boucle si le problème est ailleurs
    sessionStorage.setItem('vigil.reloaded', String(Date.now()));
  } catch { /* stockage indisponible : on recharge quand même */ }
  location.reload();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withNavigationErrorHandler(reloadOnStaleChunk)),
    provideHttpClient(withFetch(), withInterceptors([envInterceptor, authInterceptor])),
    { provide: LOCALE_ID, useValue: 'fr-FR' },
  ],
};
