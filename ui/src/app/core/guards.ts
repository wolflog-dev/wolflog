import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { sectionInfo } from './access';
import { Session } from './session';
import { Toasts } from './toasts';

/** Page réservée aux utilisateurs connectés ; mot de passe provisoire : à changer avant toute chose. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  try {
    const me = session.me() ?? (await session.load());
    if (!me.authenticated) return router.createUrlTree(['/login']);
    if (me.mustChangePassword && !state.url.startsWith('/account')) return router.createUrlTree(['/account'], { queryParams: { first: 1 } });
    return true;
  } catch {
    return router.createUrlTree(['/login']);
  }
};

/** Page réservée aux administrateurs. */
export const adminGuard: CanActivateFn = () => {
  const session = inject(Session);
  return session.isAdmin() ? true : inject(Router).createUrlTree(['/']);
};

/**
 * Partie de Wolflog (route data.section : un identifiant, ou plusieurs dont l'un suffit) hors du profil d'accès :
 * retour à la page d'accueil du profil, ou à « Mon compte ». La racine mène ainsi chacun à sa page d'accueil
 * (un product owner arrive sur l'audience) ; un lien vers une partie fermée est expliqué par une notification.
 */
export const sectionGuard: CanActivateFn = async (route, state) => {
  const section = route.data['section'] as string | string[] | undefined;
  if (!section) return true;
  const session = inject(Session);
  const router = inject(Router);
  const toasts = inject(Toasts);
  try {
    const me = session.me() ?? (await session.load());
    // Non connecté, ou mot de passe provisoire à changer : la garde d'authentification redirige (sans notification ici).
    if (!me.authenticated || me.mustChangePassword || session.can(section)) return true;
  } catch {
    return true; // session illisible : la garde d'authentification s'en charge
  }
  if (state.url.split(/[?#]/)[0] !== '/') {
    const label = sectionInfo(Array.isArray(section) ? section[0] : section)?.label ?? 'Cette page';
    toasts.info(`« ${label} » ne fait pas partie de votre profil d'accès`, 'lock');
  }
  return router.createUrlTree([session.home()]);
};
